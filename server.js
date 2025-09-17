import express from "express";
import expressWs from "express-ws";
import WebSocket from "ws";
import fetch from "node-fetch";
import { decode, encode } from "alawmulaw";   // 👈 handles μ-law audio
import dotenv from "dotenv";

dotenv.config();

const app = express();
expressWs(app);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = "gpt-4o-mini-tts";
const VOICE = "verse"; // or "marin", "alloy", etc.
const PORT = process.env.PORT || 8080;

// Helper: connect to OpenAI Realtime API
async function connectOpenAIRealtime() {
  const url = `wss://api.openai.com/v1/realtime?model=${MODEL}&voice=${VOICE}`;
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "OpenAI-Beta": "realtime=v1",
  };

  const oa = new WebSocket(url, { headers });
  return new Promise((resolve, reject) => {
    oa.on("open", () => resolve(oa));
    oa.on("error", reject);
  });
}

// Healthcheck root
app.get("/", (_req, res) => {
  res.send("✅ Twilio ↔ OpenAI Realtime voice bridge running.");
});

// Twilio WebSocket entrypoint
app.ws("/twilio", async (twilioWS, _req) => {
  console.log("📞 Twilio connected");

  // Connect to OpenAI Realtime
  let openaiWS;
  try {
    openaiWS = await connectOpenAIRealtime();
  } catch (err) {
    console.error("❌ OpenAI connection failed:", err);
    twilioWS.close();
    return;
  }

  // Have OpenAI speak first
  openaiWS.send(JSON.stringify({
    type: "response.create",
    response: {
      modalities: ["audio", "text"],   // must include both
      instructions: "Hi, thanks for calling Patch Pros! Tell me what drywall or painting work you need, and your zip code."
    }
  }));

  // Twilio → OpenAI
  twilioWS.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "media") {
        const ulawBytes = Buffer.from(data.media.payload, "base64");
        const pcm16 = decode(ulawBytes);  // decode μ-law → PCM16

        openaiWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: Buffer.from(pcm16.buffer).toString("base64"),
        }));

        // commit after each frame batch
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWS.send(JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio", "text"] }
        }));
      }

      if (data.event === "stop") {
        console.log("⏹️ Twilio stream stopped");
        openaiWS.send(JSON.stringify({ type: "response.cancel" }));
      }
    } catch (err) {
      console.error("❌ Twilio msg error:", err);
    }
  });

  twilioWS.on("close", () => {
    console.log("↘️ Twilio closed");
    try { openaiWS.close(); } catch {}
  });

  // OpenAI → Twilio
  openaiWS.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());

      if (evt.type === "response.output_audio.delta" && evt.delta) {
        const pcm16 = new Int16Array(Buffer.from(evt.delta, "base64").buffer);
        const ulawArray = encode(pcm16);  // encode PCM16 → μ-law

        twilioWS.send(JSON.stringify({
          event: "media",
          media: { payload: Buffer.from(ulawArray).toString("base64") }
        }));
      }
    } catch (err) {
      console.error("❌ OpenAI msg error:", err);
    }
  });

  openaiWS.on("close", () => {
    console.log("❌ OpenAI closed");
    try { twilioWS.close(); } catch {}
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
