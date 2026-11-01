// What an AI app may do in the editor over MCP: the list it is shown. The work itself is in src/mcpTools.js (the page).
// ask = the person is asked first, in the editor, with `says` telling them what is about to happen.
const num = (description) => ({ type: 'number', description })
const str = (description) => ({ type: 'string', description })
const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const clipId = str('The id of a clip, from get_project')
const PROPS = ['x', 'y', 'scale', 'sx', 'sy', 'rot', 'opacity']
const property = { type: 'string', enum: PROPS, description: 'x and y = position in % of the frame (default 0), scale, sx and sy = size and stretch in % (default 100), rot = degrees (default 0), opacity = % (default 100)' }

const TOOLS = [
  { name: 'get_project', description: 'Read the open video project: its files, every track and clip with ids and times, keyframes, markers and the playhead. Call this first. All times on the timeline are in seconds.', inputSchema: obj() },
  { name: 'get_preview', description: 'See the picture of the project at a moment, as an image. Moves the playhead there.', inputSchema: obj({ time: num('Seconds on the timeline (default: where the playhead is)') }) },
  { name: 'get_transcript', description: 'Read the words spoken in a video with their times, if Captions has been run on it. Times are seconds of the file.', inputSchema: obj({ mediaId: str('The id of a file, from get_project') }, ['mediaId']) },
  { name: 'list_transitions', description: 'The names of the transitions that can be used with set_transition.', inputSchema: obj() },
  { name: 'new_video_project', description: 'Open a new empty video project in a new tab.', inputSchema: obj() },
  { name: 'import_media', description: 'Add video, picture or audio files from this PC to the project.', inputSchema: obj({ paths: { type: 'array', items: { type: 'string' }, description: 'Full file paths' } }, ['paths']), ask: true, says: (a) => `Add these files to the project:\n${(a.paths || []).join('\n')}` },
  { name: 'add_clip', description: 'Put a file on the timeline. Without a time, a video or picture goes at the end of the main track. With a time, it goes on a video track that has room there. Audio goes on an audio track.', inputSchema: obj({ mediaId: str('The id of a file, from get_project'), time: num('Seconds on the timeline') }, ['mediaId']) },
  { name: 'add_text', description: 'Add text or a title. It goes on a video track with room at that time, and a new track is made only if none has room.', inputSchema: obj({ text: str('The words'), time: num('Seconds on the timeline (default: the playhead)'), duration: num('Seconds (default 3)'), y: num('Height in % of the frame, positive is up (default 0, the middle)') }, ['text']) },
  { name: 'set_text', description: 'Change the words of a text clip.', inputSchema: obj({ clipId, text: str('The new words') }, ['clipId', 'text']) },
  { name: 'move_clip', description: 'Move a clip. For a clip on the main track give index (its new place among the main track clips, 0 is first). For any other clip give start.', inputSchema: obj({ clipId, start: num('New start, seconds on the timeline'), index: num('New place on the main track') }, ['clipId']) },
  { name: 'trim_clip', description: 'Change which part of its file a clip shows.', inputSchema: obj({ clipId, from: num('Start, in seconds of the file'), to: num('End, in seconds of the file') }, ['clipId']) },
  { name: 'split_clip', description: 'Cut a clip in two at a moment.', inputSchema: obj({ time: num('Seconds on the timeline'), clipId: str('Which clip (default: the main track clip at that time)') }, ['time']) },
  { name: 'delete_clips', description: 'Delete clips from the timeline. The files on the PC are not touched.', inputSchema: obj({ clipIds: { type: 'array', items: { type: 'string' } }, closeGaps: { type: 'boolean', description: 'Slide the following main track clips back (default true)' } }, ['clipIds']), ask: true, says: (a, names) => `Delete ${(a.clipIds || []).length} clip${(a.clipIds || []).length === 1 ? '' : 's'} from the timeline.${names ? '\n' + names : ''}\nYou can undo this with Ctrl+Z.` },
  { name: 'set_value', description: 'Set position, size, rotation or opacity of a clip. If that value already has keyframes this edits or adds the keyframe at the time; otherwise it changes the value for the whole clip.', inputSchema: obj({ clipId, property, value: num('The value'), time: num('Seconds on the timeline (default: the playhead)') }, ['clipId', 'property', 'value']) },
  { name: 'add_keyframe', description: 'Add a keyframe, to animate a value over time. Use at least two at different times.', inputSchema: obj({ clipId, property, time: num('Seconds on the timeline'), value: num('The value at that moment') }, ['clipId', 'property', 'time', 'value']) },
  { name: 'remove_keyframes', description: 'Remove all the keyframes of one value of a clip and put it back to its default.', inputSchema: obj({ clipId, property }, ['clipId', 'property']) },
  { name: 'set_transition', description: 'Set the transition into a main track clip from the clip before it. Give no name for a plain cut.', inputSchema: obj({ clipId, name: str('A name from list_transitions'), duration: num('Seconds (default 1)') }, ['clipId']) },
  { name: 'set_effect', description: 'Set an effect of a clip, 0 to 100 (0 = off).', inputSchema: obj({ clipId, effect: { type: 'string', enum: ['blur', 'sharpen', 'vignette', 'glow'] }, value: num('0 to 100') }, ['clipId', 'effect', 'value']) },
  { name: 'set_volume', description: 'Set the volume of a clip. 1 is the original, 0 is silent, 2 is the most.', inputSchema: obj({ clipId, volume: num('0 to 2') }, ['clipId', 'volume']) },
  { name: 'add_marker', description: 'Put a marker on the timeline.', inputSchema: obj({ time: num('Seconds on the timeline'), label: str('Its name') }, ['time']) },
  { name: 'seek', description: 'Move the playhead.', inputSchema: obj({ time: num('Seconds on the timeline') }, ['time']) },
  { name: 'undo', description: 'Undo the last change.', inputSchema: obj() },
  { name: 'redo', description: 'Redo what was undone.', inputSchema: obj() },
  { name: 'save_project', description: 'Save the project to its file.', inputSchema: obj(), ask: true, says: () => 'Save the project.' },
  { name: 'open_export', description: 'Open the Export tab so the person can choose the settings and press Export. It does not start an export by itself.', inputSchema: obj() },
]

module.exports = { TOOLS }
