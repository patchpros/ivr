import express from "express";
import expressWs from "express-ws";
import WebSocket from "ws";
import fetch from "node-fetch";
import alawmulaw from "alawmulaw";   // 👈 μ-law <-> PCM16

// Decode/Encode functions
const { decode, encode } = alawmulaw;


// ====== CONFIG ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = "gpt-4o-realtime-preview-2024-12";   // Realtime model
const VOICE = "marin";                             // Voice option
const PORT = process.env.PORT || 10000;

// ====== EXPRESS + WS SERVER ======
const app = express();
expressWs(app);

app.get("/", (_req, res) => {
  res.send("Twilio ↔ OpenAI Realtime voice bridge running.");
});

// Twilio websocket endpoint
app.ws("/twilio", async (twilioWS, _req) => {
  console.log("🔗 Twilio connected");

  // Connect to OpenAI Realtime API
  const openaiUrl = `wss://api.openai.com/v1/realtime?model=${MODEL}&voice=${VOICE}`;
  const openaiWS = new WebSocket(openaiUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // When OpenAI connection is open
  openaiWS.on("open", () => {
    console.log("✅ OpenAI connected");
  });

  // Forward Twilio audio → OpenAI
  twilioWS.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "media") {
        const ulaw = Buffer.from(data.media.payload, "base64");
        const pcm16 = decode(ulaw); // μ-law → PCM16
        openaiWS.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: Buffer.from(pcm16.buffer).toString("base64"),
          })
        );
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWS.send(
          JSON.stringify({ type: "response.create", response: { modalities: ["audio"] } })
        );
      }
    } catch (err) {
      console.error("❌ Twilio msg error:", err);
    }
  });

  // Forward OpenAI audio → Twilio
  openaiWS.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());
      if (evt.type === "response.output_audio.delta" && evt.delta) {
        const pcm16 = new Int16Array(Buffer.from(evt.delta, "base64").buffer);
        const ulaw = encode(pcm16); // PCM16 → μ-law
        twilioWS.send(
          JSON.stringify({
            event: "media",
            media: { payload: Buffer.from(ulaw).toString("base64") },
          })
        );
      }
    } catch (err) {
      console.error("❌ OpenAI msg error:", err);
    }
  });

  // Handle closes
  twilioWS.on("close", () => {
    console.log("🔴 Twilio closed");
    try {
      openaiWS.close();
    } catch {}
  });

  openaiWS.on("close", () => {
    console.log("🔴 OpenAI closed");
    try {
      twilioWS.close();
    } catch {}
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}`);
});

