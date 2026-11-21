// The first-run tutorial: one short step per key feature, not in detail.
// target = CSS selector(s) searched inside the editor (the first one that is on screen is highlighted).
// A step without a target (or whose target is not there) is shown in the middle of the window.

export const VIDEO_STEPS = [
  {
    title: 'Welcome to the video editor',
    text: 'A short tour of how the editor is laid out. You can leave it any time, and replay it later with the ? button at the top (or Help > Tutorial).',
  },
  {
    target: '.menubar',
    title: 'Everything is in the menus',
    text: 'File, Edit, Clip, Add, Play, Timeline, View and Help hold every feature, each with its keyboard shortcut next to it. If you cannot find something, look here. Help > Keyboard shortcuts lets you change the keys.',
  },
  {
    target: '.bin .btn-row',
    title: 'Bring in your files',
    text: 'Import videos, images and music here, or just drop files onto the window. Double-click one to put it on the timeline. The small trim button on a file lets you mark the part you want first.',
  },
  {
    target: '.library',
    title: 'Library',
    text: 'Keep things you use again and again (an intro, a logo, a song) so they are one click away in every project.',
  },
  {
    target: '.preview-area',
    title: 'Preview',
    text: 'Your video plays here. Hold Ctrl and use the mouse wheel to zoom into the picture. The quality menu next to the zoom makes playback lighter on a slow PC.',
  },
  {
    target: '.transport',
    title: 'The play bar',
    text: 'In the middle: play, and step one frame at a time. On the left: mark the In and Out of a part (keys I and O). On the right: play just that part, lift it out (leaves a gap) or extract it (closes the gap). J, K and L play backwards, stop and play forwards.',
  },
  {
    target: '.tl-scroll',
    title: 'Timeline',
    text: 'Drag clips to move them and drag their edges to trim. Right-click a clip to split, copy, group, nest or colour it. Drag the thin bar above the timeline to make it taller, and the bottom edge of a track name to make that track taller.',
  },
  {
    target: '.tl-toolbar .tool-group',
    title: 'Trim tools',
    text: 'Select and move is the normal tool. Ripple, roll, slip and slide are the trim tools editors use to fine-tune cuts. Hover one to see what it does.',
  },
  {
    target: '.tl-toolbar',
    title: 'Timeline toolbar',
    text: 'The things you use all the time: undo, split and delete, then text, captions, voice-over and markers. On the right: snapping, closing gaps, tracks, track heights and zoom.',
  },
  {
    target: '.tl-toolbar button[title^="Captions"]',
    title: 'Captions',
    text: 'Turns the words in your video into text clips, timed to the speech, and can save a subtitles file. Then Edit by text lets you cut the video by deleting words, filler words (um, uh) and long pauses. It needs a one-time model download, and works offline after that.',
  },
  {
    target: '.meter-col',
    side: 'left',
    title: 'Sound meters',
    text: 'How loud your video is while it plays. Loud parts are best around -6 dB. If the red light at the top comes on, it got too loud.',
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
    text: 'Move, resize and rotate the picture, animate it with keyframes, and bend it with Funny warp. Speed, reverse and Stabilise (for shaky clips) are here too. A dot next to a section means something is changed in it.',
  },
  {
    select: 'first',
    side: 'left',
    tab: 'look',
    target: ['.insp-tabs button[data-tab="look"]', '.inspector'],
    title: 'Look: effects, colour and masks',
    text: 'Blur, glow, green screen, colour correction and LUT colour looks. Masks show only part of a clip: Smart select finds a person or object with a click, and a mask can follow the video.',
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
    text: 'Pick how a clip comes in from the one before it. This tab shows for a clip that has another clip in front of it. Your own transitions go in the transitions folder (button at the bottom of this tab).',
  },
  {
    target: '.aspect-select',
    title: 'Video shape',
    text: 'Choose landscape, vertical for phones, square and more.',
  },
  {
    target: '.menu-name[data-menu="File"]',
    title: 'Saving and history',
    text: 'Save, Save as and Version history are in the File menu. Earlier copies of your project are kept, so you can go back if something goes wrong.',
  },
  {
    target: '.topbar .primary',
    title: 'Export',
    text: 'When you are happy, export your video. You can pick quality, a graphics card for speed, or audio only, and export everything, the part between In and Out, or just the selected clips.',
  },
  {
    title: 'That is the tour',
    text: 'Have fun. Hovering over almost any button shows what it does, and the menus list everything with its shortcut. Press the ? button at the top to see this again.',
  },
]
export const IMAGE_STEPS = [
  {
    title: 'Welcome to the picture editor',
    text: 'Edit pictures and paint: layers, brushes with pen pressure, selections, text, masks and effects. A short tour of the main things; leave it any time and replay it with the ? button at the top (or Help > Tutorial).',
  },
  {
    target: '.menubar',
    title: 'Everything is in the menus',
    text: 'File, Edit, Layer, Select, Tools, View and Help hold every feature, each with its key next to it. If you cannot find something, look here.',
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
