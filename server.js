import express from "express";
import expressWs from "express-ws";
import WebSocket from "ws";
import OpenAI from "openai";

const app = express();
expressWs(app); // enable WebSocket on Express

const PORT = process.env.PORT || 10000;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// health check
app.get("/", (req, res) => {
  res.send("✅ Twilio <-> OpenAI realtime server running");
});

// WebSocket endpoint Twilio will connect to
app.ws("/twilio", async (ws, req) => {
  console.log("Twilio connected");

  // connect to OpenAI realtime API
  const oa = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  oa.on("open", () => {
    console.log("✅ OpenAI connected");
    // optional: configure session
    oa.send(
      JSON.stringify({
        type: "session.update",
        session: {
          voice: "marin",
          input_audio_format: "mulaw",
          output_audio_format: "mulaw",
          turn_detection: { type: "server_vad" }
        }
      })
    );
  });

  oa.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.type === "response.audio.delta") {
      // stream audio chunks back to Twilio
      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: data.delta }
        })
      );
    }

    if (data.type === "response.audio.done") {
      ws.send(JSON.stringify({ event: "mark", mark: { name: "audio_done" } }));
    }

    if (data.type === "response.audio_transcript.delta") {
      console.log("Transcript:", data.delta);
    }
  });

  oa.on("close", () => {
    console.log("❌ OpenAI closed");
    ws.close();
  });

  ws.on("message", (msg) => {
    const event = JSON.parse(msg.toString());

    if (event.event === "media") {
      // forward audio from Twilio → OpenAI
      oa.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: event.media.payload
        })
      );
    }

    if (event.event === "start") {
      console.log("📞 Call started");
    }

    if (event.event === "stop") {
      console.log("📞 Call ended");
      oa.close();
    }
  });

  ws.on("close", () => {
    console.log("❌ Twilio closed");
    oa.close();
  });
});

// start server
app.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}`);
});
