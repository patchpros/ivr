// Twilio <-> OpenAI Realtime voice bridge
// Env var on Render: OPENAI_API_KEY

import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = "gpt-4o-realtime-preview";
const VOICE = "marin";

// ---------- μ-law <-> PCM16 ----------
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

// ---------- OpenAI Realtime WS ----------
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

// ---------- HTTP health ----------
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Twilio ↔ OpenAI Realtime voice bridge running.");
});

// ---------- Upgrade WS only for /twilio ----------
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else socket.destroy();
});

// ================== Main bridge ==================
wss.on("connection", async (twilioWS) => {
  console.log("➡️  Twilio connected");
  if (!OPENAI_API_KEY) { console.error("❌ Missing OPENAI_API_KEY"); twilioWS.close(); return; }

  let openaiWS;
  try { openaiWS = await connectOpenAI(); }
  catch { twilioWS.close(); return; }

  // Tell OpenAI exactly what audio formats we use
  openaiWS.send(JSON.stringify({
    type: "session.update",
    session: {
      voice: VOICE,
      // what we send in (after decoding/upsampling)
      input_audio_format: { type: "pcm16", sample_rate_hz: 16000 },
      // what we want back
      output_audio_format: { type: "pcm16", sample_rate_hz: 16000 },
      // keep VAD out of the way; we control turns
      turn_detection: { type: "none" }
    }
  }));

  let responseInFlight = false;          // true while model is speaking
  let sawAnyAudioDelta = false;
  let safetyRepromptTimer;

  function askToSpeak(instructions = "") {
    if (responseInFlight) return;        // don’t overlap responses
    responseInFlight = true;
    console.log("↗️  response.create", instructions ? "(greeting)" : "(turn)");

    openaiWS.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions,
        conversation: "auto"             // valid: 'auto' | 'none'
      }
    }));

    clearTimeout(safetyRepromptTimer);
    safetyRepromptTimer = setTimeout(() => {
      if (!sawAnyAudioDelta && !responseInFlight) {
        console.log("⏰ no deltas yet; nudging once");
        askToSpeak("");
      }
    }, 1500);
  }

  // Greet once
  askToSpeak("Hi, thanks for calling Patch Pros! Tell me the drywall or painting work you need and your zip code, and I’ll give you a quick ballpark.");

  // --------- Buffer ≥120ms before commit (only when idle) ---------
  let audioChunks = [];
  let samples16k = 0;
  const MIN_MS = 120;
  const THRESH = Math.ceil((MIN_MS / 1000) * 16000);  // ~1920 samples

  twilioWS.on("message", (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      if (data.event === "start") {
        console.log("🎙️  Twilio stream start");
        return;
      }

      if (data.event === "media") {
        const b64 = data.media?.payload;
        if (!b64) return;
        const mu = Buffer.from(b64, "base64");
        if (!mu.length) return;

        const pcm8k = muLawDecode(new Uint8Array(mu));
        const pcm16k = upsample8kTo16k(pcm8k);
        if (!pcm16k.length) return;

        audioChunks.push(pcm16k);
        samples16k += pcm16k.length;

        // Only commit when we really have ≥120ms AND model is idle
        if (samples16k >= THRESH && !responseInFlight) {
          const out = new Int16Array(samples16k);
          let off = 0;
          for (const c of audioChunks) { out.set(c, off); off += c.length; }

          if (out.length > 0) {
            openaiWS.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: Buffer.from(out.buffer).toString("base64")
            }));
            openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            console.log(`↘️  committed ${samples16k} samples (~${Math.round(samples16k/160)}ms)`);
          }

          audioChunks = [];
          samples16k = 0;
          askToSpeak("");
        }
        return;
      }

      if (data.event === "stop") {
        console.log("⏹️  Twilio stream stop");
        try { openaiWS.send(JSON.stringify({ type: "response.cancel" })); } catch {}
        try { openaiWS.close(); } catch {}
        return;
      }
    } catch (e) {
      console.error("Twilio msg error:", e?.message || e);
    }
  });

  twilioWS.on("close", () => {
    console.log("↘️  Twilio closed");
    try { openaiWS.close(); } catch {}
    clearTimeout(safetyRepromptTimer);
  });

  // OpenAI -> Twilio (log *all* event types so we see what's happening)
  openaiWS.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());
      if (evt?.type) {
        if (evt.type !== "response.output_audio.delta" &&
            evt.type !== "response.audio.delta") {
          console.log("OpenAI evt:", evt.type);
        }
      }

      // Accept both delta event names
      if ((evt.type === "response.output_audio.delta" || evt.type === "response.audio.delta") && evt.delta) {
        sawAnyAudioDelta = true;
        const pcm16k = new Int16Array(Buffer.from(evt.delta, "base64").buffer);
        if (!pcm16k.length) return;
        const pcm8k = downsample16kTo8k(pcm16k);
        const mu = muLawEncode(pcm8k);
        twilioWS.send(JSON.stringify({
          event: "media",
          media: { payload: Buffer.from(mu).toString("base64") }
        }));
        return;
      }

      if (evt.type === "response.completed") {
        responseInFlight = false;
        clearTimeout(safetyRepromptTimer);
        console.log("✔️  response.completed");
        return;
      }

      if (evt.type === "response.error" || evt.type === "error") {
        console.error("OpenAI error event:", evt);
        responseInFlight = false; // allow recovery
        return;
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

// Start server
server.listen(PORT, () => console.log("Server listening on", PORT));
