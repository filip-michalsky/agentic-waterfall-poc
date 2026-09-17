# Reel: Checkout.com → Adyen → Stripe

One 36-second story in three formats. It follows the [live demo](https://soap-agentic-waterfall-demo.vercel.app/live)
and [animated diagram](payment-flow.svg).

## Files

Generated files stay in `packages/orchestrator/out/reel/`, outside Git:

| File | Format |
| --- | --- |
| `reel-16x9.mp4` | 1920×1080 |
| `reel-1x1.mp4` | 1080×1080 |
| `reel-9x16.mp4` | 1080×1920 |

`work/unified/` contains the scene clips. `cover-*.jpg` and `storyboard-*.jpg`
contain the matching stills. Original footage and older clips remain intact.

## Edit

| Time | On screen |
| --- | --- |
| 0–3s | Checkout.com API → Adyen API → Stripe browser. |
| 3–11s | Token → Basis Theory Proxy → Checkout.com; simulated decline. |
| 11–17s | Adyen API request → test-triggered refusal. |
| 17–19s | Handoff to Stripe’s browser checkout. |
| 19–31s | Clean Stripe Browserbase footage: fill and submit. |
| 31–36s | Confirmed Stripe payment and the live demo URL. |

The progress strip names both API providers separately. Moving packets show
request and response direction. Captions fit each format. Every frame says
**TEST CARDS · NO REAL MONEY**. Only the CVV is pixelated.

The API scenes are illustrations. Adyen’s depicted response was verified in its
sandbox on September 8; rendering makes no provider calls. Stripe is a separate
recorded take, `vid-stripe2`, trimmed to seconds 4–38.5 and sped up 2.875×.
That recording used automatic capture, so the reel says **payment confirmed**.
The hosted live demo uses manual capture and reports **authorized, not captured**.

## Rebuild

From the repository root:

```sh
bash packages/orchestrator/media/build-reel.sh --preview
bash packages/orchestrator/media/build-reel.sh
```

Requires Python 3, Pillow, ffmpeg/ffprobe, and the macOS Avenir Next and Menlo fonts.
The inputs are `out/vid-stripe2/video/stripe.mp4` and its `attempts.json` under
`packages/orchestrator/`. `--aspect 9x16` renders one format.

The renderer reads no environment files and makes no network calls.
Exports are silent H.264 at 30 fps, with fast-start playback metadata.
