import express from "express";
import expressWs from "express-ws";
import WebSocket from "ws";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = "gpt-4o-realtime-preview-2024-12";
const VOICE = "marin";
const PORT = process.env.PORT || 10000;

const app = express();
expressWs(app);

app.get("/", (_req, res) => {
  res.send("Twilio ↔ OpenAI Realtime voice bridge is running.");
});

app.ws("/twilio", (twilioWS) => {
  console.log("🔗 Twilio connected");

  // Connect to OpenAI Realtime
  const oa = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${MODEL}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  let canRespond = true; // gate to avoid "active response" errors

  oa.on("open", () => {
    console.log("✅ OpenAI connected");

    // Make formats match Twilio exactly: G.711 μ-law @ 8 kHz both directions.
    // Note: Realtime expects strings for formats (not objects).
    oa.send(
      JSON.stringify({
        type: "session.update",
        session: {
          voice: VOICE,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          // server_vad enables voice-activity-based turn taking
          turn_detection: { type: "server_vad" },
        },
      })
    );

    // Assistant speaks first
    canRespond = false;
    oa.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Hi, thanks for calling Patch Pros! Tell me what drywall or painting work you need and your ZIP code, and I’ll give you a quick ballpark. If the request is outside drywall/painting, ask for a clearer description.",
        },
      })
    );
  });

  // ----- Twilio -> OpenAI -----
  twilioWS.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.event === "start") {
        // stream started
        return;
      }

      if (data.event === "media") {
        // Twilio sends base64 G.711 μ-law @ 8kHz in data.media.payload.
        // Forward as-is (no transcoding).
        oa.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload, // base64 bytes
          })
        );

        // Commit this chunk. Only ask for a response if we're not already speaking.
        oa.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        if (canRespond) {
          canRespond = false;
          oa.send(
            JSON.stringify({
              type: "response.create",
              response: { modalities: ["audio", "text"] },
            })
          );
        }
        return;
      }

      if (data.event === "stop") {
        // Caller hung up stream; close OpenAI nicely.
        try {
          oa.close();
        } catch {}
        return;
      }
    } catch (err) {
      console.error("❌ Twilio msg error:", err);
    }
  });

  // ----- OpenAI -> Twilio -----
  oa.on("message", (raw) => {
    try {
      const evt = JSON.parse(raw.toString());

      // Stream audio back to caller. Because we set output_audio_format=g711_ulaw,
      // evt.delta is already base64 μ-law 8kHz — just pass it through.
      if (evt.type === "response.output_audio.delta" && evt.delta) {
        twilioWS.send(
          JSON.stringify({
            event: "media",
            media: { payload: evt.delta },
          })
        );
      }

      // When a response is done, allow the next one.
      if (
        evt.type === "response.completed" ||
        evt.type === "response.output_audio.done" ||
        evt.type === "response.done"
      ) {
        canRespond = true;
      }
    } catch (err) {
      console.error("❌ OpenAI evt error:", err);
    }
  });

  // ----- Clean up -----
  twilioWS.on("close", () => {
    console.log("🔴 Twilio closed");
    try {
      oa.close();
    } catch {}
  });

  oa.on("close", () => {
    console.log("🔴 OpenAI closed");
    try {
      twilioWS.close();
    } catch {}
  });

  oa.on("error", (e) => console.error("❌ OpenAI WS error:", e));
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}`);
});
