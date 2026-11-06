# ISS Tracker

A live 3D globe of the International Space Station, a countdown to its next **visible** flyover over
your city, and a **Sky view**: point your phone's camera at the sky and the app draws where the ISS
is and the path it will take.

## Pages
- `index.html` shows the globe: the ISS position, orbit trail and visibility footprint, a day/night
  Earth lit by the real Sun, the next visible pass with a countdown, and a list of upcoming passes.
- `sky.html` is the camera sky view. It draws the ISS, the pass path with minute marks, the Sun,
  the Moon, the horizon and compass points, and an arrow that tells you which way to turn.
  **Preview pass** plays the next pass at 30× speed. **Adjust** has a compass fix slider and a
  zoom slider.

## How it works
- Orbit data (TLE) comes from wheretheiss.at, with CelesTrak as a fallback, and is refreshed every
  6 h. A built-in TLE covers offline use.
- satellite.js (SGP4) propagates the orbit in the browser. A pass counts as *visible* when the ISS
  is ≥10° up, is lit by the Sun, and your sky is dark (Sun below −6°).
- The Sky view uses the camera (`getUserMedia`), the compass and tilt sensors (`deviceorientation`)
  and your location. Phones only allow these on an **https** link.

## Run locally
```bash
python -m http.server 8777 --directory iss-tracker
```
Open http://localhost:8777. The globe works on a computer. The sky view on a computer falls back to
drag-to-look-around without a camera.

## On a phone
Host the folder on any https static host (GitHub Pages, Netlify, Cloudflare Pages), open the link on
the phone, then use **Add to Home Screen**. It installs like an app, with an icon and full screen,
and works offline with the last orbit data.

Phone compasses can be off by 5–20°. If the Sun or Moon marker doesn't sit on the real one, use
**Adjust → Compass fix**, or wave the phone in a figure-8.
