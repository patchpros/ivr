import http from "http";
import crypto from "crypto";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

// ====== CONFIG ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // set this in your host
const CHATGPT_VOICE = "verse"; // OpenAI voice (e.g., "alloy", "verse")
const MODEL = "gpt-4o-mini-tts"; // realtime TTS-capable model
const PORT = process.env.PORT || 8080;

// --- simple μ-law <-> PCM16 helpers (Twilio media streams are 8k μ-law mono) ---
function muLawDecode(mu) {
  // mu: Uint8Array -> Int16Array
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;
  const out = new Int16Array(mu.length);
  for (let i = 0; i < mu.length; i++) {
    let u = ~mu[i];
    let s = (u & 0x80) ? -1 : 1;
    let e = (u >> 4) & 0x07;
    let q = u & 0x0F;
    let t = ((q << 3) + MULAW_BIAS) << (e + 3);
    out[i] = s * (t - MULAW_BIAS);
  }
  return out;
}
function muLawEncode(pcm16) {
  // pcm16: Int16Array -> Uint8Array
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

// Optional simple 8k -> 16k upsample (nearest)
function upsample8kTo16k(int16_8k) {
  const out = new Int16Array(int16_8k.length * 2);
  for (let i = 0; i < int16_8k.length; i++) {
    out[2*i] = int16_8k[i];
    out[2*i+1] = int16_8k[i];
  }
  return out;
}
// Optional 16k -> 8k downsample (drop)
function downsample16kTo8k(int16_16k) {
  const out = new Int16Array(Math.floor(int16_16k.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = int16_16k[2*i];
  return out;
}

// ====== OPENAI REALTIME WS CONNECT ======
async function connectOpenAIRealtime() {
  // Create a signed URL for OpenAI realtime WS
  const url = "wss://api.openai.com/v1/realtime?model=" + encodeURIComponent(MODEL);
  const headers = {
    "Authorization": `Bearer ${OPENAI_API_KEY}`,
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

wss.on("connection", async (twilioWS, req) => {
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

  // 1) Immediately tell ChatGPT to SPEAK FIRST (greeting)
  openaiWS.send(JSON.stringify({
    type: "response.create",
    response: {
      modalities: ["audio"],
      instructions:
        "Hi, thanks for calling Patch Pros! I’m your estimate assistant. " +
        "Tell me what drywall or painting work you need, and your zip code, " +
        "so I can give you a quick ballpark."
    }
  }));

  // --- Twilio → OpenAI: on Twilio media frames, forward audio to ChatGPT ---
  twilioWS.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.event === "start") {
        console.log("Twilio stream start:", data);
      } else if (data.event === "media") {
        // Twilio sends base64 μ-law @ 8k
        const mu = Buffer.from(data.media.payload, "base64");
        const pcm16 = muLawDecode(new Uint8Array(mu));
        const pcm16_16k = upsample8kTo16k(pcm16); // OpenAI prefers 16k

        // Append audio to Realtime
        openaiWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: Buffer.from(pcm16_16k.buffer).toString("base64"),
          // If the API supports explicit format fields in your version, you could include them here
        }));
        // Tell model to process
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWS.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio"] }}));
      } else if (data.event === "stop") {
        console.log("Twilio stream stop");
        openaiWS.send(JSON.stringify({ type: "response.cancel" }));
      }
    } catch (e) {
      console.error("Twilio msg error:", e);
    }
  });

  twilioWS.on("close", () => {
    console.log("Twilio closed");
    try { openaiWS.close(); } catch {}
  });

  // --- OpenAI → Twilio: stream ChatGPT voice back to the caller ---
  openaiWS.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());
      if (evt.type === "response.output_audio.delta" && evt.delta) {
        // evt.delta is base64-encoded PCM16 @ 16k from OpenAI
        const pcm16_16k = new Int16Array(Buffer.from(evt.delta, "base64").buffer);
        const pcm16_8k = downsample16kTo8k(pcm16_16k);
        const mu = muLawEncode(pcm16_8k);
        // Send to Twilio as a media message
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
