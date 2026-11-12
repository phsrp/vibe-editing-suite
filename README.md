<div align="center">

<img src="docs/banner.png" alt="Completely made with AI: Vibe Editing Suite was designed, written, tested and packaged by Claude (Anthropic) from plain-English instructions." width="100%">

</div>

<div align="center">

# Vibe Editing Suite

</div>

<div align="center">

A Windows video editor and picture editor focused on simplicity with many features content creators need  
**Every line of it was written by AI.**

</div>

<div align="center">

[![Download](https://img.shields.io/github/v/release/phsrp/Vibe-editing-suite?label=download&color=c4a7e7&style=for-the-badge)](https://github.com/phsrp/Vibe-editing-suite/releases/latest) ![Made with AI](https://img.shields.io/badge/made%20with-AI-ebbcba?style=for-the-badge) ![Windows](https://img.shields.io/badge/platform-Windows-31748f?style=for-the-badge)

</div>

<div align="center">

## Connect an AI app (MCP)

An AI app on your PC, such as Claude, can use the whole editor for you while it is open: video and pictures. It uses [MCP](https://modelcontextprotocol.io), an open standard for connecting AI apps to programs. It is off until you turn it on.

1. Open **Settings > AI connection** and turn the switch on.
2. Copy the text from the setup guide on that page into your AI app. For Claude Desktop that is Settings > Developer > Edit Config, then restart it. For Claude Code it is one command. If you use Claude Code inside the Claude desktop app, paste that command into a Code chat and ask Claude to add it.
3. Start a new chat in your AI app and ask something like "look at my timeline and add a title at the start", or "make a thumbnail in the style of this picture".

**What it can do:** nearly everything you can do with the mouse.

- **Video:** see the picture at any moment, and cut, trim, move and arrange clips and tracks, with text, keyframes, speed, transitions, effects, colour, green screen, masks, sound clean-up and markers. It can also write new transitions.
- **Tracking:** "zoom in and track that person" follows them with normal keyframes you can edit, and masks can follow a subject too.
- **Captions and speech:** make captions from speech, cut words, filler words and pauses out by text, save subtitles.
- **Pictures:** make thumbnails and posters with layers, blend modes, gradients, shapes and glows, cut a subject out of its background, paint with real brushes, make selections, and look at a picture on your PC to copy its style.
- **Finishing:** save projects, go back to earlier versions, and export videos (all of it or a part) and pictures, with long jobs showing their progress and a Cancel button.
- **The editor itself:** open and switch projects, and change settings, themes and shortcuts.

Tracking and smart cut-outs use the tracking AI model, and captions use the speech model. If one is missing, the AI can download it after you allow it.

You see every change as it happens, and Ctrl+Z takes it back. The editor asks you first before it deletes clips, opens or adds files, saves or exports, changes a setting, downloads something or uses the microphone. Things it cannot do: draw with pen pressure in real time, move the panels around, install updates.

The connection only works on this PC, and any MCP app that can start a local program can use it. Open the editor first: if your AI app was started while the editor was closed, or the editor has just updated, restart the AI app or reconnect it.

## Tutorial included, don't worry

*(for new users: there is an included tutorial, do not worry)*

The first time you open the video editor or the picture editor, a short tour shows you the key features, one step at a time. You can skip it, and replay it any time with the **?** button at the top.

<img src="docs/screenshots/tutorial-video.png" alt="The tutorial in the video editor, explaining Transform and Funny warp" width="48%"> <img src="docs/screenshots/tutorial-image.png" alt="The tutorial in the image editor, explaining Transform and Funny warp" width="48%">

</div>

## How to download

1. Open the [latest release](https://github.com/phsrp/Vibe-editing-suite/releases/latest) (the purple **download** button at the top of this page does the same).
2. Under **Assets**, click `Vibe-Editing-Suite-Setup-<version>.exe`.
3. Run the file you downloaded. It installs just for you (no administrator needed) and puts a shortcut on your desktop and in the Start menu.
4. **If Windows says "Windows protected your PC":** the installer is not code-signed yet, so Windows is careful with it. Click **More info**, then **Run anyway**.

You only do this once. After that the app checks for a new version each time it opens and asks before downloading it, so you can update from inside the app.

## What the version numbers mean

Every version is three numbers separated by dots, for example **1.7.1**:

```
  1   .   7   .   1
  │       │       └── minor update: fixes and small improvements
  │       └────────── major update: a big batch of new features (counts from 0 to 9)
  └────────────────── goes up by one when the major number would pass 9
```

- **Minor update (the last number)** goes up for small changes: bug fixes, polish, small additions. `1.7.0` → `1.7.1`.
- **Major update (the middle number)** goes up for a big update with new features, and the minor number starts again from 0. `1.7.1` → `1.8.0`. It counts from 0 up to 9.
- **The first number** only changes when the major number runs out: after `1.9.x` the next big update is `2.0.0`.

So a bigger number on the left always means a newer version: `1.7.1` is newer than `1.7.0`, and `1.8.0` is newer than `1.7.9`.

## Built with

- [Electron](https://www.electronjs.org/) and [React](https://react.dev/), with WebGL for the preview and transitions
- [FFmpeg](https://ffmpeg.org/) through `ffmpeg-static` for import, audio and export. **Note:** that FFmpeg build includes GPL-licensed encoders (x264 and x265), which matters if you redistribute the installer.
- Transition format from [gl-transitions](https://gl-transitions.com/)
- [Montserrat](https://github.com/JulietaUla/Montserrat) font (SIL Open Font License)
- [Rosé Pine](https://rosepinetheme.com/) colours (MIT)
- [SAM 2.1](https://github.com/facebookresearch/sam2) by Meta (Apache-2.0), exported to ONNX for the browser by [Diffusion Studio](https://huggingface.co/diffusionstudio/sam2.1-small-video-onnx-fp16) (Apache-2.0), for smart select and mask tracking. The distractor-aware memory is [DAM4SAM](https://github.com/jovanavidenovic/DAM4SAM) by Videnovic et al. (Apache-2.0). How its video loop fits together follows Meta's code and the open reference runtime in [diffusionstudio/editor](https://github.com/diffusionstudio/editor/tree/main/packages/sam2) (MPL-2.0). It is downloaded on request, not included in the installer.
- [ONNX Runtime Web](https://onnxruntime.ai/) (MIT) to run that model on your PC
- [Whisper](https://github.com/openai/whisper) base by OpenAI (MIT) for captions from speech, as ONNX files by [onnx-community](https://huggingface.co/onnx-community/whisper-base), run with [Transformers.js](https://huggingface.co/docs/transformers.js) (Apache-2.0). Downloaded on request, not included in the installer.
- Icons drawn in the style of [Lucide](https://lucide.dev/) (ISC)
