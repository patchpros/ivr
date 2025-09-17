// Twilio <-> OpenAI Realtime bridge
// Render env var: OPENAI_API_KEY

import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Realtime voice model
const MODEL = "gpt-4o-realtime-preview";
// TTS voice
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

  // Tell OpenAI formats + let it handle VAD/turns (no manual commit)
  openaiWS.send(JSON.stringify({
    type: "session.update",
    session: {
      voice: VOICE,
      input_audio_format:  { type: "pcm16", sample_rate_hz: 16000 },
      output_audio_format: { type: "pcm16", sample_rate_hz: 16000 },
      turn_detection: { type: "server_vad" } // <-- IMPORTANT
    }
  }));

  // Start with a greeting
  openaiWS.send(JSON.stringify({
    type: "response.create",
    response: {
      modalities: ["audio","text"],
      conversation: "auto",
      instructions:
        "Hi, thanks for calling Patch Pros! Tell me the drywall or painting work you need and your zip code, and I’ll give you a quick ballpark."
    }
  }));

  // Twilio -> OpenAI: just append audio; NO commit
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

        openaiWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: Buffer.from(pcm16k.buffer).toString("base64")
        }));
        // NO input_audio_buffer.commit — VAD will end turns
        return;
      }

      if (data.event === "stop") {
        console.log("⏹️  Twilio stream stop");
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
  });

  // OpenAI -> Twilio
  openaiWS.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());
      // Log key lifecycle events
      if (evt?.type && !["response.output_audio.delta","response.audio.delta"].includes(evt.type)) {
        console.log("OpenAI evt:", evt.type);
      }

      // Audio back to Twilio (either event name)
      if ((evt.type === "response.output_audio.delta" || evt.type === "response.audio.delta") && evt.delta) {
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
        console.log("✔️  response.completed");
        return;
      }

      if (evt.type === "response.error" || evt.type === "error") {
        console.error("OpenAI error event:", evt);
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
