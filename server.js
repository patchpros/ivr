import express from "express";
import expressWs from "express-ws";
import WebSocket from "ws";
import { RealtimeClient } from "@openai/realtime-client";
import { decode, encode } from "alawmulaw";

const app = express();
expressWs(app);

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Helper: PCM16 base64 → μ-law base64
function pcm16ToUlawBase64(base64PCM) {
  const pcm16Buffer = Buffer.from(base64PCM, "base64");
  const pcm16Array = new Int16Array(pcm16Buffer.buffer, pcm16Buffer.byteOffset, pcm16Buffer.length / 2);
  const ulawArray = ulaw.encode(pcm16Array);
  return Buffer.from(ulawArray).toString("base64");
}

app.ws("/twilio", (twilioWS) => {
  console.log("🔗 Twilio connected");

  let currentStreamSid = null;
  let oaWS = null;
  let audioBuffer = [];
  let lastResponseDone = true;

  // Connect to OpenAI Realtime
  oaWS = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  oaWS.on("open", () => {
    console.log("✅ OpenAI connected");
  });

  oaWS.on("message", (msg) => {
    const event = JSON.parse(msg);

    // Handle audio coming back from OpenAI
    if (event.type === "response.audio.delta" && twilioWS.readyState === 1) {
      const ulawBase64 = pcm16ToUlawBase64(event.delta);
      twilioWS.send(
        JSON.stringify({
          event: "media",
          streamSid: currentStreamSid,
          media: { payload: ulawBase64 },
        })
      );
    }

    if (event.type === "response.done") {
      lastResponseDone = true;
    }
  });

  // Handle audio from Twilio
  twilioWS.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      currentStreamSid = data.start.streamSid;
      console.log("📞 Call started:", currentStreamSid);
    }

    if (data.event === "media") {
      // Decode μ-law → PCM16
      const ulawBytes = Buffer.from(data.media.payload, "base64");
      const pcm16 = ulaw.decode(ulawBytes); // Int16Array
      const pcm16Buffer = Buffer.from(pcm16.buffer);
      const base64PCM = pcm16Buffer.toString("base64");

      // Collect audio frames
      audioBuffer.push(base64PCM);

      // Flush ~10 frames at a time
      if (audioBuffer.length >= 10 && oaWS?.readyState === 1 && lastResponseDone) {
        audioBuffer.forEach((frame) => {
          oaWS.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: frame,
            })
          );
        });
        audioBuffer = [];

        // Commit + trigger response
        oaWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        oaWS.send(
          JSON.stringify({
            type: "response.create",
            response: { modalities: ["audio", "text"], conversation: "auto" },
          })
        );

        lastResponseDone = false;
      }
    }

    if (data.event === "stop") {
      console.log("⛔ Call ended");
      if (oaWS) oaWS.close();
      twilioWS.close();
    }
  });

  twilioWS.on("close", () => console.log("❌ Twilio closed"));
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}`);
});

