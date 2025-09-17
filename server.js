import express from "express";
import expressWs from "express-ws";
import WebSocket from "ws";
import fetch from "node-fetch";
import alawmulaw from "alawmulaw";   // 👈 handles μ-law audio from Twilio

const app = express();
expressWs(app);

const PORT = process.env.PORT || 10000;

// ---- OpenAI Realtime connection ----
async function connectOpenAI() {
  const resp = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-realtime-preview-2024-12-17",
      voice: "marin",
    }),
  });

  if (!resp.ok) {
    throw new Error(`OpenAI session failed: ${resp.statusText}`);
  }

  return resp.json();
}

// ---- Twilio ↔ OpenAI bridge ----
app.ws("/twilio", async (ws, req) => {
  console.log("🔔 Twilio connected");

  let openAiSocket;
  try {
    const session = await connectOpenAI();

    openAiSocket = new WebSocket(session.client_secret.value, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    openAiSocket.on("open", () => {
      console.log("✅ OpenAI connected");
    });

    openAiSocket.on("message", (msg) => {
      const data = JSON.parse(msg);
      if (data.type === "response.output_audio.delta") {
        // PCM16 → μ-law → Base64
        const pcm16 = Buffer.from(data.delta, "base64");
        const ulawEncoded = alawmulaw.ulaw.encode(pcm16);
        const b64u = Buffer.from(ulawEncoded).toString("base64");

        ws.send(
          JSON.stringify({
            event: "media",
            media: { payload: b64u },
          })
        );
      }
    });

    openAiSocket.on("close", () => {
      console.log("❌ OpenAI closed");
      ws.close();
    });

    openAiSocket.on("error", (err) => {
      console.error("OpenAI error:", err);
      ws.close();
    });
  } catch (err) {
    console.error("Failed to connect to OpenAI:", err);
    ws.close();
    return;
  }

  // ---- Handle audio from Twilio ----
  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      console.log("📞 Call started");
    }

    if (data.event === "media" && openAiSocket?.readyState === WebSocket.OPEN) {
      try {
        // μ-law → PCM16
        const ulawBytes = Buffer.from(data.media.payload, "base64");
        const pcm16 = alawmulaw.ulaw.decode(ulawBytes);

        openAiSocket.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: Buffer.from(pcm16).toString("base64"),
          })
        );
      } catch (err) {
        console.error("Twilio msg error:", err);
      }
    }

    if (data.event === "stop") {
      console.log("🛑 Twilio stream stop");
      openAiSocket?.close();
      ws.close();
    }
  });

  ws.on("close", () => {
    console.log("🔌 Twilio closed");
    openAiSocket?.close();
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}`);
});
