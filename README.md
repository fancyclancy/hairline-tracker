# Hairline Tracker

A personal iPhone web app for tracking hair regrowth on finasteride + minoxidil.

- **Daily:** log finasteride, minoxidil AM and minoxidil PM
- **Weekly:** front hairline and crown photos, with a ghost overlay of last week's photo so every shot lines up
- **Impressions:** a quick weekly gut check (Worse / No change / Maybe better / Clearly better)
- **Progress:** before/after slider, side-by-side, timelapse, 3/6/9/12-month milestones
- **Private:** all photos and logs are stored on the phone only (IndexedDB). Nothing is uploaded.

## Install
Open https://fancyclancy.github.io/hairline-tracker/ in Safari → Share → **Add to Home Screen**.

## Develop
Plain HTML/CSS/JS, no build step.

```bash
python3 -m http.server 8765
```
