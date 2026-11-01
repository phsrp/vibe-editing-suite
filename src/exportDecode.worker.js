// Export: reads and unpacks source frames off the page's own thread, which has enough to do with rendering them.
// The picture comes out flipped the way the renderer wants it, so uploading it needs no slow flip.
self.onmessage = async (e) => {
  const { id, url } = e.data
  try {
    const r = await fetch(url)
    if (!r.ok) return self.postMessage({ id })
    const bmp = await createImageBitmap(await r.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    self.postMessage({ id, bmp }, [bmp])
  } catch {
    self.postMessage({ id }) // not there yet: the page asks again
  }
}
