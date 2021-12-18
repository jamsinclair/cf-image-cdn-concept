import decodeJpeg, { init as initJpegDecodeWasm } from '@jsquash/jpeg/decode';
import decodePng, { init as initPngDecodeWasm } from '@jsquash/png/decode';
import encodeJpeg, { init as initJpegEncodeWasm } from '@jsquash/jpeg/encode';
import encodePng, { init as initPngEncodeWasm } from '@jsquash/png/encode';
import encodeWebp, { init as initWebpWasm } from '@jsquash/webp/encode';
import resize, { initResize } from '@jsquash/resize';

// Simple Polyfill for ImageData Object
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const MONTH_IN_SECONDS = 30 * 24 * 60 * 60;
const CDN_CACHE_AGE = 6 * MONTH_IN_SECONDS; // 6 Months
const SUPPORTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const DECODABLE_EXTENSIONS = ['jpg', 'jpeg', 'png'];

const decodeImage = async (buffer, format) => {
  if (format === 'jpeg' || format === 'jpg') {
    // @Note, we need to manually instantiate the wasm module here
    // CF Workers do not support dynamic imports and inject the WASM binary as a global var
    initJpegDecodeWasm(JPEG_DEC_WASM);
    return decodeJpeg(buffer);
  } else if (format === 'png') {
    // @Note, we need to manually instantiate the wasm module here
    // CF Workers do not support dynamic imports and inject the WASM binary as a global var
    initPngDecodeWasm(PNG_WASM);
    return decodePng(buffer);
  }

  throw new Error(`Unsupported format: ${format}`);
}

const encodeImage = async (imageData, format) => {
  if (format === 'jpeg' || format === 'jpg') {
    // @Note, we need to manually instantiate the wasm module here
    // CF Workers do not support dynamic imports and inject the WASM binary as a global var
    initJpegEncodeWasm(JPEG_ENC_WASM);
    return encodeJpeg(imageData);
  } else if (format === 'png') {
    // @Note, we need to manually instantiate the wasm module here
    // CF Workers do not support dynamic imports and inject the WASM binary as a global var
    initPngEncodeWasm(PNG_WASM);
    return encodePng(imageData);
  }

  throw new Error(`Unsupported format: ${format}`);
}

const resizeImage = async (imageData, width, height) => {
  const { width: imageWidth, height: imageHeight } = imageData;
  const ratio = imageWidth / imageHeight;
  const newWidth = width > 0 ? width : Math.round(height * ratio);
  const newHeight = height > 0 ? height : Math.round(width / ratio);
  initResize(RESIZE_WASM);
  return resize(imageData, { width: newWidth, height: newHeight });
}

async function handleRequest(request, ctx) {
  const requestUrl = new URL(request.url);
  const extension = requestUrl.pathname.split('.').pop();
  const isWebpSupported = request.headers.get('accept').includes('image/webp');
  const isImageDecodable = DECODABLE_EXTENSIONS.includes(extension);
  const cacheKeyUrl = isWebpSupported && isImageDecodable ? requestUrl.toString().replace(`.${extension}`, '.webp') : requestUrl.toString();
  const cacheKey = new Request(cacheKeyUrl, request);
  const cache = caches.default;
  const resizeWidth = Number(requestUrl.searchParams.get('w'));
  const resizeHeight = Number(requestUrl.searchParams.get('h'));
  
  let response = await cache.match(cacheKey);
  
  if (!response) {
    const isUnsupportedImage = !SUPPORTED_EXTENSIONS.includes(extension);
    if (isUnsupportedImage) {
      return new Response('Not found', { status: 404 });
    }

    // Assuming the pathname includes a full url, e.g. jamie.tokyo/images/compressed/spare-magnets.jpg
    response = await fetch(`https://${requestUrl.pathname.replace(/^\//, '')}`);
    if (response.status > 299 || response.status < 200) {
      return new Response('Not found', { status: 404 });
    }

    if (isWebpSupported && isImageDecodable) {
      let imageData = await decodeImage(await response.arrayBuffer(), extension);

      if (resizeWidth || resizeHeight) {
        imageData = await resizeImage(imageData, resizeWidth, resizeHeight);
      }

      const quality = Number(requestUrl.searchParams.get('q')) || 80;
      // @Note, we need to manually instantiate the wasm module here
      // CF Workers do not support dynamic imports and inject the WASM binary as a global var
      await initWebpWasm(WEBP_ENC_WASM);
      const webpImage = await encodeWebp(imageData, { quality });
      response = new Response(webpImage, response);
      response.headers.set('Content-Type', 'image/webp');
    } else if (isImageDecodable && (resizeWidth || resizeHeight)) {
      const imageData = await decodeImage(await response.arrayBuffer(), extension);
      const resizedImageData = await resizeImage(imageData, resizeWidth, resizeHeight);
      response = new Response(await encodeImage(resizedImageData, extension), response);
    }

    response = new Response(response.body, response);
    response.headers.append("Cache-Control", `s-maxage=${CDN_CACHE_AGE}`);

    // Use waitUntil so you can return the response without blocking on
    // writing to cache
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  return response;
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request, event));
});
