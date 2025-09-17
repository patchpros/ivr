import express from "express";
import expressWs from "express-ws";
import WebSocket from "ws";
import alawmulaw from "alawmulaw";

const { decode, encode } = alawmulaw.ulaw;

const app = express();
expressWs(app);

const PORT = process.env.PORT || 10000;

// WebSocket endpoint Twilio connects to
app.ws("/twilio", async (ws, req) => {
  console.log("🔔 Twilio connected");

  // Connect to OpenAI Realtime API
  let openAiSocket;
  try {
    openAiSocket = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );
  } catch (err) {
    console.error("❌ Failed to connect to OpenAI:", err);
    ws.close();
    return;
  }

  // When OpenAI socket opens
  openAiSocket.on("open", () => {
    console.log("✅ OpenAI connected");
  });

  // Messages from OpenAI
  openAiSocket.on("message", (raw) => {
    const data = JSON.parse(raw.toString());

    if (data.type === "response.output_audio.delta") {
      // OpenAI sends PCM16 → encode to μ-law for Twilio
      const pcm16 = Buffer.from(data.delta, "base64");
      const ulawEncoded = encode(pcm16);
      const b64u = Buffer.from(ulawEncoded).toString("base64");

      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: b64u },
        })
      );
    }
  });

  openAiSocket.on("close", () => {
    console.log("❌ OpenAI closed");
    ws.close();
  });

  openAiSocket.on("error", (err) => {
    console.error("❌ OpenAI error:", err);
    ws.close();
  });

  // Messages from Twilio
  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.event === "media") {
      // Twilio sends μ-law → decode to PCM16 → forward to OpenAI
      const ulawBytes = Buffer.from(data.media.payload, "base64");
      const pcm16 = decode(ulawBytes);

      if (openAiSocket && openAiSocket.readyState === WebSocket.OPEN) {
        openAiSocket.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: Buffer.from(pcm16).toString("base64"),
          })
        );
      }
    } else if (data.event === "start") {
      console.log("▶️ Call started");
    } else if (data.event === "stop") {
      console.log("⏹️ Call ended");
      if (openAiSocket && openAiSocket.readyState === WebSocket.OPEN) {
        openAiSocket.close();
      }
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio closed");
    if (openAiSocket && openAiSocket.readyState === WebSocket.OPEN) {
      openAiSocket.close();
    }
  });
});

// Root
app.get("/", (req, res) => {
  res.send("Twilio ↔ OpenAI IVR running");
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}`);
});
