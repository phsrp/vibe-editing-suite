// The first-run tutorial: one short step per key feature, not in detail.
// target = CSS selector(s) searched inside the editor (the first one that is on screen is highlighted).
// A step without a target (or whose target is not there) is shown in the middle of the window.

export const VIDEO_STEPS = [
  {
    title: 'Welcome to the video editor',
    text: 'A one-minute tour of the main things. You can leave it any time, and replay it later with the ? button at the top.',
  },
  {
    target: '.bin .btn-row',
    title: 'Bring in your files',
    text: 'Import videos, images and music here, or just drop files onto the window. Double-click one to put it on the timeline.',
  },
  {
    target: '.library',
    title: 'Library',
    text: 'Keep things you use again and again (an intro, a logo, a song) so they are one click away in every project.',
  },
  {
    target: '.preview-area',
    title: 'Preview',
    text: 'Your video plays here. Hold Ctrl and use the mouse wheel to zoom into the picture, which helps when you draw masks. The quality menu next to the zoom makes playback lighter on a slow PC.',
  },
  {
    target: '.tl-scroll',
    title: 'Timeline',
    text: 'Drag clips to move them and drag their edges to trim. Drag a clip sideways to leave a gap. Add more tracks to stack videos on top of each other. Drag the thin bar above the timeline to make it taller.',
  },
  {
    target: '.tl-toolbar',
    title: 'Timeline tools',
    text: 'Split a clip at the playhead (select only its sound and just the sound is cut), freeze a frame, group clips, add markers, and record a voice-over. Hover a button to see what it does.',
  },
  {
    target: '.tl-toolbar button[title^="Add text"]',
    title: 'Text and titles',
    text: 'Adds a text clip at the playhead. Pick a style and a font in the inspector on the right.',
  },
  {
    target: '.tl-toolbar button[title^="Captions"]',
    title: 'Captions',
    text: 'Turns the words in your video into text clips, timed to the speech, and can save a subtitles file. Then Edit by text lets you cut the video by deleting words, filler words (um, uh) and long pauses. It needs a one-time model download, and works offline after that.',
  },
  {
    // select = the tour picks a clip so there is something to show; tab = it opens that tab of the inspector
    select: 'first',
    side: 'left',
    target: ['.insp-tabs', '.inspector'],
    title: 'The inspector has tabs',
    text: 'Click a clip and the inspector shows tabs: Clip, Look, Audio and Transition (and Text for a text clip). Each tab holds one kind of job, so you only see what you need.',
  },
  {
    select: 'first',
    side: 'left',
    tab: 'clip',
    target: ['.insp-tabs button[data-tab="clip"]', '.inspector'],
    title: 'Clip: position, size and speed',
    text: 'Move, resize and rotate the picture, animate it with keyframes, and bend it with Funny warp. Speed and reverse are here too. A dot next to a section means something is changed in it.',
  },
  {
    select: 'first',
    side: 'left',
    tab: 'look',
    target: ['.insp-tabs button[data-tab="look"]', '.inspector'],
    title: 'Look: effects, colour and masks',
    text: 'Blur, glow, green screen and colour correction. Masks show only part of a clip: Smart select finds a person or object with a click, and a mask can follow the video with AI (needs a graphics card and a one-time model download) or with Quick tracking (follows the movement, needs nothing).',
  },
  {
    select: 'first',
    side: 'left',
    tab: 'audio',
    target: ['.insp-tabs button[data-tab="audio"]', '.inspector'],
    title: 'Audio: volume and clean-up',
    text: 'Every clip has its own volume. Open "Clean up the sound" for noise reduction, cutting low rumble and voice presets.',
  },
  {
    select: 'second',
    side: 'left',
    tab: 'transition',
    target: ['.insp-tabs button[data-tab="transition"]', '.inspector'],
    title: 'Transition: coming in from the previous clip',
    text: 'Pick how a clip comes in from the one before it. This tab shows for a clip that has another clip in front of it. You can add your own transitions too.',
  },
  {
    target: '.aspect-select',
    title: 'Video shape',
    text: 'Choose landscape, vertical for phones, square and more.',
  },
  {
    target: '.topbar button[title^="Version"]',
    title: 'History',
    text: 'Earlier copies of your project are kept, so you can go back if something goes wrong.',
  },
  {
    target: '.topbar .primary',
    title: 'Export',
    text: 'When you are happy, export your video as MP4. You can pick quality, a graphics card for speed, or audio only.',
  },
  {
    title: 'That is the tour',
    text: 'Have fun. Hovering over almost any button shows what it does. Press the ? button at the top to see this again.',
  },
]

export const IMAGE_STEPS = [
  {
    title: 'Welcome to the picture editor',
    text: 'Edit pictures and paint: layers, brushes with pen pressure, selections, text, masks and effects. A short tour of the main things; leave it any time and replay it with the ? button at the top.',
  },
  {
    target: '.toolbar-v',
    title: 'Tools',
    text: 'Move, brush, eraser, smudge, line, shapes, fill, eyedropper, selections and text. Hover a tool to see its key. Painting tools open their settings and brushes on the right; Alt picks a colour.',
  },
  {
    target: '.toolbar-v',
    title: 'Select and move things',
    text: 'Select clicks a line or shape. Lasso selects what you draw around. Smart select (AI) finds the exact edge of a subject from a click or a rough box. Then drag inside a selection to move those pixels, or hold Alt to move a copy.',
  },
  {
    target: '.layers .layer-add',
    title: 'Layers',
    text: 'Everything lives on its own layer: pictures, paint (layers of pixels) and text. Add one here, then drag layers up and down to change what is on top. Open picture at the top starts from a picture on your computer.',
  },
  {
    target: ['.layers .layer-row', '.layers .bin-list'],
    title: 'Hide, lock and fade',
    text: 'Use the eye to hide a layer and the lock to protect it. Double-click a name to rename it.',
  },
  {
    target: '.preview-area',
    title: 'The canvas',
    text: 'Hold Ctrl and use the mouse wheel to zoom in, and drag with the middle mouse button to move around. Great for tight masks.',
  },
  {
    target: ['[data-sec="transform"]', '.inspector'],
    title: 'Move, resize and warp',
    text: 'Click a layer, then use Transform to move, resize and rotate it, and change its opacity. Funny warp lets you drag the four corners to bend it.',
  },
  {
    target: ['[data-sec="mask"]', '.inspector'],
    title: 'Masks and AI select',
    text: 'Show only part of a layer. Smart select finds a subject with a click. It needs a graphics card and a one-time model download.',
  },
  {
    target: ['[data-sec="effects"]', '.inspector'],
    title: 'Effects and colour',
    text: 'Blur, glow, green screen and colour correction for the selected layer.',
  },
  {
    target: ['[data-sec="canvas"]', '.inspector'],
    title: 'Canvas size',
    text: 'With no layer selected, change the size and the background of the canvas here.',
  },
  {
    target: '.topbar button[title^="Undo"]',
    title: 'Undo',
    text: 'Made a mistake? Undo (Ctrl+Z) takes back a stroke, a move or a layer. Redo is Ctrl+Y.',
  },
  {
    target: '.topbar .primary',
    title: 'Export',
    text: 'Save your picture as PNG, JPG or WebP, at the canvas size or bigger.',
  },
  {
    title: 'That is the tour',
    text: 'Have fun. Hovering over almost any button shows what it does. Press the ? button at the top to see this again.',
  },
]
