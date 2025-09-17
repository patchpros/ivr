import express from "express";
import expressWebSocket from "express-ws";
import WebSocket from "ws";
import fetch from "node-fetch";

const app = express();
expressWebSocket(app, null, { perMessageDeflate: true });

app.ws("/media-stream", async (ws, req) => {
  console.log("🔗 Twilio stream connected");

  // 1. Create OpenAI Realtime session
  const resp = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-realtime-preview-2024-12-17",
      voice: "marian",              // choose a voice
      input_audio_format: "pcm16",  // Twilio sends PCM16
      output_audio_format: "pcm16", // return PCM16 to Twilio
    }),
  });
  const session = await resp.json();

  // 2. Connect to OpenAI Realtime WebSocket
  const openai = new WebSocket(session.client_secret.value, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });

  let streamSid = null;

  ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    // Grab stream SID from Twilio
    if (data.event === "start") {
      streamSid = data.start.streamSid;
      console.log("✅ Twilio stream started:", streamSid);
    }

    // Forward microphone audio → OpenAI
    if (data.event === "media" && openai.readyState === WebSocket.OPEN) {
      openai.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload, // base64 PCM16 from Twilio
        })
      );
    }

    // Commit buffer after Twilio stops sending
    if (data.event === "mark" && openai.readyState === WebSocket.OPEN) {
      openai.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      openai.send(JSON.stringify({ type: "response.create" }));
    }
  });

  // 3. Handle OpenAI → Twilio
  openai.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    // Forward AI audio back to Twilio
    if (evt.type === "response.output_audio.delta" && streamSid) {
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: evt.delta }, // already base64 PCM16
        })
      );
    }

    // Log transcript
    if (evt.type === "response.audio_transcript.delta") {
      process.stdout.write(evt.delta);
    }

    if (evt.type === "response.done") {
      console.log("\n🤖 AI finished speaking\n");
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio WebSocket closed");
    openai.close();
  });
});

app.listen(3000, () => console.log("🚀 Listening on ws://localhost:3000/media-stream"));
