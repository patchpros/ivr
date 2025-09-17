// server.js

import express from "express";
import expressWs from "express-ws";
import WebSocket from "ws";

// ====== CONFIG ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = "gpt-4o-realtime-preview-2024-12"; // realtime-capable
const VOICE = "marin"; // pick a voice
const PORT = process.env.PORT || 10000;

const app = express();
expressWs(app);

// --- μ-law <-> PCM16 helpers (Twilio = 8k µ-law mono) ---
function muLawDecode(mu) {
  const MULAW_BIAS = 33;
  const out = new Int16Array(mu.length);
  for (let i = 0; i < mu.length; i++) {
    let u = ~mu[i];
    let sign = (u & 0x80) ? -1 : 1;
    let e = (u >> 4) & 0x07;
    let q = u & 0x0F;
    let t = ((q << 3) + MULAW_BIAS) << (e + 3);
    out[i] = sign * (t - MULAW_BIAS);
  }
  return out;
}
function muLawEncode(pcm16) {
  const out = new Uint8Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    let s = pcm16[i];
    let sign = (s < 0) ? 0x80 : 0x00;
    if (s < 0) s = -s;
    if (s > 32635) s = 32635;
    s += 132;
    let e = 7;
    for (let expMask = 0x4000; (s & expMask) === 0 && e > 0; e--, expMask >>= 1) {}
    let q = (s >> (e + 3)) & 0x0F;
    let u = ~(sign | (e << 4) | q) & 0xFF;
    out[i] = u;
  }
  return out;
}
function upsample8kTo16k(int16_8k) {
  const out = new Int16Array(int16_8k.length * 2);
  for (let i = 0; i < int16_8k.length; i++) {
    out[2 * i] = int16_8k[i];
    out[2 * i + 1] = int16_8k[i];
  }
  return out;
}
function downsample16kTo8k(int16_16k) {
  const out = new Int16Array(Math.floor(int16_16k.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = int16_16k[2 * i];
  return out;
}

// ====== Twilio → OpenAI bridge ======
app.ws("/twilio", async (twilioWS) => {
  console.log("📞 Twilio connected");

  // Connect to OpenAI Realtime
  const oaUrl = `wss://api.openai.com/v1/realtime?model=${MODEL}`;
  const oa = new WebSocket(oaUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  // Track if OpenAI is ready
  let oaReady = false;
  oa.on("open", () => {
    oaReady = true;
    console.log("🤖 OpenAI connected");

    // Configure session
    oa.send(JSON.stringify({
      type: "session.update",
      session: {
        input_audio_format: "pcm16",
        output_audio_format: "g711_ulaw", // Twilio format
        voice: VOICE,
        turn_detection: { type: "server_vad" }
      }
    }));

    // Greeting response
    oa.send(JSON.stringify({
      type: "response.create",
      response: { instructions: "Hello! How can I help you today?" }
    }));
  });

  // --- Twilio → OpenAI ---
  twilioWS.on("message", (msg) => {
    if (!oaReady) return;
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "media") {
        const mu = Buffer.from(data.media.payload, "base64");
        const pcm16_8k = muLawDecode(new Uint8Array(mu));
        const pcm16_16k = upsample8kTo16k(pcm16_8k);

        oa.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: Buffer.from(pcm16_16k.buffer).toString("base64"),
        }));
      } else if (data.event === "mark") {
        oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        oa.send(JSON.stringify({ type: "response.create" }));
      }
    } catch (e) {
      console.error("Twilio msg error:", e);
    }
  });

  twilioWS.on("close", () => {
    console.log("📞 Twilio closed");
    try { oa.close(); } catch {}
  });

  // --- OpenAI → Twilio ---
  oa.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());

      if (evt.type === "response.output_audio.delta" && evt.delta) {
        const pcm16 = new Int16Array(Buffer.from(evt.delta, "base64").buffer);
        const pcm8k = downsample16kTo8k(pcm16);
        const mu = muLawEncode(pcm8k);

        twilioWS.send(JSON.stringify({
          event: "media",
          media: { payload: Buffer.from(mu).toString("base64") }
        }));
      }

      if (evt.type === "response.audio_transcript.delta") {
        console.log("📝 Transcript:", evt.delta);
      }
    } catch (e) {
      console.error("OpenAI msg error:", e);
    }
  });

  oa.on("close", () => {
    console.log("🤖 OpenAI closed");
    try { twilioWS.close(); } catch {}
  });
});

// ====== Health check ======
app.get("/", (req, res) => {
  res.send("Twilio ↔ OpenAI voice bridge is live.");
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}`);
});
