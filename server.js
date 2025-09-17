import express from "express";
import expressWs from "express-ws";
import WebSocket from "ws";

const app = express();
expressWs(app);

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.ws("/twilio", (twilioWS, req) => {
  console.log("🔗 Twilio connected");

  let currentStreamSid = null;
  let oaWS = null;
  let audioBuffer = [];
  let lastResponseDone = true;

  // Connect to OpenAI Realtime API
  oaWS = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  oaWS.on("open", () => {
    console.log("✅ OpenAI connected");
  });

  oaWS.on("message", (msg) => {
    const event = JSON.parse(msg);

    // Debug logs
    // console.log("OA EVT:", event);

    if (event.type === "response.audio.delta" && twilioWS.readyState === 1) {
      // Send audio back to Twilio
      twilioWS.send(JSON.stringify({
        event: "media",
        streamSid: currentStreamSid,
        media: { payload: event.delta }
      }));
    }

    if (event.type === "response.done") {
      lastResponseDone = true;
    }
  });

  oaWS.on("close", () => console.log("❌ OpenAI closed"));
  oaWS.on("error", (err) => console.error("OpenAI error:", err));

  // Handle incoming Twilio messages
  twilioWS.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      currentStreamSid = data.start.streamSid;
      console.log("📞 Call started:", currentStreamSid);
    }

    if (data.event === "media") {
      // Collect ~200ms of audio before committing
      audioBuffer.push(data.media.payload);

      if (audioBuffer.length >= 10 && oaWS?.readyState === 1 && lastResponseDone) {
        audioBuffer.forEach((frame) => {
          oaWS.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: frame
          }));
        });
        audioBuffer = [];

        oaWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        oaWS.send(JSON.stringify({
          type: "response.create",
          response: { modalities: ["audio", "text"], conversation: "auto" }
        }));

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
