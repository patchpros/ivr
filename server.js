// Twilio <-> OpenAI Realtime voice bridge (μ-law passthrough)
// Env vars on Render: OPENAI_API_KEY
// Number points to Twilio Function that <Stream>s to wss://YOUR-RENDER.onrender.com/twilio

import express from "express";
import expressWs from "express-ws";
import WebSocket from "ws";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const MODEL = "gpt-4o-realtime-preview"; // realtime-capable model
const VOICE = "marin";                    // OpenAI voice

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const app = express();
expressWs(app);

// Health
app.get("/", (_req, res) => res.send("✅ Twilio ↔ OpenAI realtime server running"));

// WebSocket endpoint Twilio connects to via <Stream>
app.ws("/twilio", async (twilioWS) => {
  console.log("📞 Twilio connected");

  // Connect to OpenAI Realtime WS
  const oaWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      }
    }
  );

  let oaReady = false;
  let streamSid = null;
  const pending = []; // queue Twilio audio frames until OpenAI is ready

  oaWS.on("open", () => {
    console.log("🤖 OpenAI connected");
    oaReady = true;

    // Configure session: EXACT strings for formats; let server VAD manage turns.
    oaWS.send(JSON.stringify({
      type: "session.update",
      session: {
        voice: VOICE,
        input_audio_format:  "g711_ulaw", // Twilio Media Streams codec
        output_audio_format: "g711_ulaw", // so we can pass deltas straight back
        turn_detection: { type: "server_vad" }
      }
    }));

    // Speak first (greeting)
    oaWS.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        conversation: "auto",
        instructions:
          "Hi, thanks for calling Patch Pros! Tell me the drywall or painting work you need and your zip code, and I’ll give you a quick ballpark."
      }
    }));

    // Flush any buffered Twilio audio
    while (pending.length) oaWS.send(pending.shift());
  });

  oaWS.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());

      // Forward audio back to Twilio (either event name variant)
      if ((evt.type === "response.output_audio.delta" || evt.type === "response.audio.delta") && evt.delta) {
        if (twilioWS.readyState === WebSocket.OPEN && streamSid) {
          twilioWS.send(JSON.stringify({
            event: "media",
            streamSid, // REQUIRED by Twilio when sending back
            media: { payload: evt.delta } // already base64 G.711 μ-law @ 8k
          }));
        }
        return;
      }

      if (evt.type === "response.completed") {
        // Finished a TTS turn
        return;
      }

      if (evt.type === "response.audio_transcript.delta") {
        // Live transcript (debug)
        process.stdout.write(evt.delta);
        return;
      }

      if (evt.type === "error" || evt.type === "response.error") {
        console.error("OpenAI error:", evt);
      }
    } catch (e) {
      console.error("OpenAI msg parse error:", e);
    }
  });

  oaWS.on("close", () => {
    console.log("🤖 OpenAI closed");
    try { twilioWS.close(); } catch {}
  });

  // Twilio -> OpenAI
  twilioWS.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "start") {
        streamSid = data.start?.streamSid || null;
        console.log("▶️ Twilio stream started:", streamSid || "(no sid)");
        return;
      }

      if (data.event === "media") {
        // media.payload is base64 μ-law @ 8k; pass through to OpenAI
        // Queue the frame
const payload = JSON.stringify({
  type: "input_audio_buffer.append",
  audio: data.media.payload
});
if (oaReady) oaWS.send(payload); else pending.push(payload);

// Auto-commit every ~200ms so OpenAI knows a user turn is coming in
if (oaReady) {
  if (!twilioWS._lastCommit || Date.now() - twilioWS._lastCommit > 200) {
    oaWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    oaWS.send(JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio", "text"], conversation: "auto" }
    }));
    twilioWS._lastCommit = Date.now();
  }
}

        return;
      }

      if (data.event === "stop") {
        console.log("⏹️ Twilio stream stop");
        try { oaWS.close(); } catch {}
        return;
      }

      // Other events: mark, dtmf, etc. (ignored)
    } catch (e) {
      console.error("Twilio msg parse error:", e);
    }
  });

  twilioWS.on("close", () => {
    console.log("📴 Twilio closed");
    try { oaWS.close(); } catch {}
  });

  // Keep-alives to avoid idle timeouts
  const ping = setInterval(() => {
    try { if (twilioWS.readyState === WebSocket.OPEN) twilioWS.ping(); } catch {}
    try { if (oaWS.readyState === WebSocket.OPEN) oaWS.ping(); } catch {}
  }, 25000);
  const clear = () => { try { clearInterval(ping); } catch {} };
  twilioWS.on("close", clear);
  oaWS.on("close", clear);
});

// Start
app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));

