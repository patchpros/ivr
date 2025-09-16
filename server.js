const PROMPT_ID = "pmpt_68c995a081d48197b3a2f234ed3320b10a877ec0b3af0900";
const MODEL = "gpt-4o-mini-tts";   // realtime TTS-capable
const VOICE = "Marin";             // match your OpenAI playground voice

import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

// ====== CONFIG ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // set this in Render
const PORT = process.env.PORT || 8080;

// --- μ-law <-> PCM16 helpers (Twilio media streams are 8k μ-law mono) ---
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

// ====== OPENAI REALTIME WS CONNECT ======
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

// ====== HTTP + WS SERVER ======
const server = http.createServer((_req, res) => {
  res.writeHead(200);
  res.end("Twilio ↔ OpenAI Realtime voice bridge running.");
});

const wss = new WebSocketServer({ server, path: "/twilio" });

wss.on("connection", async (twilioWS) => {
  console.log("Twilio connected");

  // Connect to OpenAI Realtime
  let openaiWS;
  try {
    openaiWS = await connectOpenAIRealtime();
  } catch (e) {
    console.error("OpenAI WS failed:", e);
    twilioWS.close();
    return;
  }

  // 1) Assistant speaks first using your saved Ballpark Voice prompt
  openaiWS.send(JSON.stringify({
    type: "response.create",
    response: {
      modalities: ["audio"],
      conversation: "default",
      instructions: "",
      prompt: PROMPT_ID
    }
  }));

  // --- Twilio → OpenAI ---
  twilioWS.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "media") {
        const mu = Buffer.from(data.media.payload, "base64");
        const pcm16 = muLawDecode(new Uint8Array(mu));
        const pcm16_16k = upsample8kTo16k(pcm16);
        openaiWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: Buffer.from(pcm16_16k.buffer).toString("base64"),
        }));
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWS.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] }}));
      }
    } catch (e) {
      console.error("Twilio msg error:", e);
    }
  });

  twilioWS.on("close", () => {
    console.log("Twilio closed");
    try { openaiWS.close(); } catch {}
  });

  // --- OpenAI → Twilio ---
  openaiWS.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());
      if (evt.type === "response.output_audio.delta" && evt.delta) {
        const pcm16_16k = new Int16Array(Buffer.from(evt.delta, "base64").buffer);
        const pcm16_8k = downsample16kTo8k(pcm16_16k);
        const mu = muLawEncode(pcm16_8k);
        twilioWS.send(JSON.stringify({
          event: "media",
          media: { payload: Buffer.from(mu).toString("base64") }
        }));
      }
    } catch (e) {
      console.error("OpenAI msg error:", e);
    }
  });

  openaiWS.on("close", () => {
    console.log("OpenAI closed");
    try { twilioWS.close(); } catch {}
  });
});

server.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
