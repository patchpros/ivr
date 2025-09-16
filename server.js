// Twilio <-> OpenAI Realtime bridge (guards for empty commit + response queue)
// Env: OPENAI_API_KEY

import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = "gpt-4o-realtime-preview";
const VOICE = "marin";

// --------- μ-law <-> PCM16 helpers ----------
function muLawDecode(u8) {
  const BIAS = 33;
  const out = new Int16Array(u8.length);
  for (let i = 0; i < u8.length; i++) {
    let u = ~u8[i];
    let sign = (u & 0x80) ? -1 : 1;
    let exp = (u >> 4) & 7;
    let mant = u & 0x0F;
    let mag = ((mant << 3) + BIAS) << (exp + 3);
    out[i] = sign * (mag - BIAS);
  }
  return out;
}
function muLawEncode(pcm) {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let s = pcm[i], sign = 0;
    if (s < 0) { sign = 0x80; s = -s; }
    if (s > 32635) s = 32635;
    s += 132;
    let exp = 7;
    for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
    let mant = (s >> (exp + 3)) & 0x0F;
    out[i] = ~(sign | (exp << 4) | mant) & 0xFF;
  }
  return out;
}
const upsample8kTo16k = (a8k) => {
  const out = new Int16Array(a8k.length * 2);
  for (let i = 0; i < a8k.length; i++) { out[2*i] = a8k[i]; out[2*i+1] = a8k[i]; }
  return out;
};
const downsample16kTo8k = (a16k) => {
  const out = new Int16Array(Math.floor(a16k.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = a16k[2*i];
  return out;
};

// --------- OpenAI Realtime connect ----------
function connectOpenAI() {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "OpenAI-Beta": "realtime=v1",
  };
  const ws = new WebSocket(url, { headers });
  return new Promise((resolve, reject) => {
    ws.on("open", () => { console.log("✅ OpenAI connected"); resolve(ws); });
    ws.on("error", (e) => { console.error("❌ OpenAI WS error:", e?.message || e); reject(e); });
    ws.on("close", () => { console.log("❌ OpenAI closed"); });
  });
}

// --------- HTTP health ----------
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Twilio ↔ OpenAI Realtime voice bridge running.");
});

// --------- Upgrade only /twilio ----------
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ======== Main bridge ========
wss.on("connection", async (twilioWS) => {
  console.log("➡️  Twilio connected");

  if (!OPENAI_API_KEY) {
    console.error("❌ Missing OPENAI_API_KEY");
    twilioWS.close();
    return;
  }

  let openaiWS;
  try {
    openaiWS = await connectOpenAI();
  } catch {
    twilioWS.close();
    return;
  }

  // Voice + initial greeting
  openaiWS.send(JSON.stringify({ type: "session.update", session: { voice: VOICE } }));
  let responseInFlight = false;        // avoid "active_response" errors

  function createResponse(instructions) {
    if (responseInFlight) return;       // don't overlap
    responseInFlight = true;
    openaiWS.send(JSON.stringify({
      type: "response.create",
      response: { modalities: ["audio","text"], instructions }
    }));
  }

  // initial greeting
  createResponse("Hi, thanks for calling Patch Pros! Tell me the drywall or painting work you need and your zip code, and I’ll give you a quick ballpark.");

  // Buffer audio ≥ 120ms before commit
  let audioChunks = [];
  let samples16k = 0;
  const MIN_MS = 120;
  const SAMPLES_THRESHOLD = Math.ceil((MIN_MS / 1000) * 16000); // ~1920

  function commitIfReady() {
    if (samples16k >= SAMPLES_THRESHOLD) {
      const total = samples16k;
      const buf = new Int16Array(total);
      let off = 0;
      for (const c of audioChunks) { buf.set(c, off); off += c.length; }

      // append then commit — GUARDED
      openaiWS.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: Buffer.from(buf.buffer).toString("base64")
      }));
      openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

      // only ask for a response if we're not already speaking
      if (!responseInFlight) {
        createResponse(""); // no extra instructions; continue conversation
      }

      // reset buffer
      audioChunks = [];
      samples16k = 0;
    }
  }

  // Twilio -> OpenAI
  twilioWS.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "media") {
        const mu = Buffer.from(data.media.payload, "base64");
        const pcm8k = muLawDecode(new Uint8Array(mu));
        const pcm16k = upsample8kTo16k(pcm8k);

        audioChunks.push(pcm16k);
        samples16k += pcm16k.length;

        commitIfReady();
      } else if (data.event === "start") {
        console.log("🎙️  Twilio stream start");
      } else if (data.event === "stop") {
        console.log("⏹️  Twilio stream stop");
        // one last guarded flush
        commitIfReady();
        try { openaiWS.send(JSON.stringify({ type: "response.cancel" })); } catch {}
        try { openaiWS.close(); } catch {}
      }
    } catch (e) {
      console.error("Twilio msg error:", e?.message || e);
    }
  });

  twilioWS.on("close", () => {
    console.log("↘️  Twilio closed");
    try { openaiWS.close(); } catch {}
  });

  // OpenAI -> Twilio
  openaiWS.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());

      if (evt.type === "response.output_audio.delta" && evt.delta) {
        const pcm16k = new Int16Array(Buffer.from(evt.delta, "base64").buffer);
        const pcm8k = downsample16kTo8k(pcm16k);
        const mu = muLawEncode(pcm8k);
        twilioWS.send(JSON.stringify({
          event: "media",
          media: { payload: Buffer.from(mu).toString("base64") }
        }));
      } else if (evt.type === "response.completed") {
        // TTS turn finished — we may create a new response when audio arrives
        responseInFlight = false;
      } else if (evt.type === "error") {
        console.error("OpenAI error event:", evt);
        // On error, allow next response attempt
        responseInFlight = false;
      }
    } catch (e) {
      console.error("OpenAI msg error:", e?.message || e);
    }
  });

  // Keep-alives
  const ping = setInterval(() => { try { twilioWS.ping(); } catch {}; try { openaiWS.ping(); } catch {}; }, 25000);
  const clear = () => { try { clearInterval(ping); } catch {}; };
  twilioWS.on("close", clear);
  openaiWS.on("close", clear);
});

// --------- start ----------
server.listen(PORT, () => console.log("Server listening on", PORT));
