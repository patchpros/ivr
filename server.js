// Twilio <-> OpenAI Realtime (μ-law passthrough)
// Render env var required: OPENAI_API_KEY

import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = "gpt-4o-realtime-preview";
const VOICE = "marin";

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

  // Exact formats Twilio uses for Media Streams: μ-law 8k
  openaiWS.send(JSON.stringify({
    type: "session.update",
    session: {
      voice: VOICE,
      input_audio_format:  { type: "g711_ulaw", sample_rate_hz: 8000 },
      output_audio_format: { type: "g711_ulaw", sample_rate_hz: 8000 },
      turn_detection: { type: "server_vad" }
    }
  }));

  // Greet immediately
  openaiWS.send(JSON.stringify({
    type: "response.create",
    response: {
      modalities: ["audio", "text"],
      conversation: "auto",
      instructions:
        "Hi, thanks for calling Patch Pros! Tell me the drywall or painting work you need and your zip code, and I’ll give you a quick ballpark."
    }
  }));

  // Twilio -> OpenAI (μ-law passthrough, NO commit)
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
        openaiWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          // payload is already g711_ulaw@8k base64 — pass through
          audio: b64
        }));
        return; // no commit: server_vad handles turns
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

  // OpenAI -> Twilio (μ-law passthrough)
  openaiWS.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());
      if (evt?.type && !["response.output_audio.delta","response.audio.delta"].includes(evt.type)) {
        console.log("OpenAI evt:", evt.type);
      }

      // Audio deltas: already g711_ulaw@8k base64 -> send right back to Twilio
      if ((evt.type === "response.output_audio.delta" || evt.type === "response.audio.delta") && evt.delta) {
        twilioWS.send(JSON.stringify({
          event: "media",
          media: { payload: evt.delta }
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
