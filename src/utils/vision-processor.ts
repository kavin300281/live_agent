/**
 * Utilities for capturing video frames for the Gemini Live API.
 */

export class VisionProcessor {
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D | null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.context = this.canvas.getContext('2d');
  }

  captureFrame(video: HTMLVideoElement): string | null {
    if (!this.context) return null;

    // Set canvas dimensions to match video or a reasonable size for the API
    const width = 640;
    const height = (video.videoHeight / video.videoWidth) * width;
    
    this.canvas.width = width;
    this.canvas.height = height;

    this.context.drawImage(video, 0, 0, width, height);
    
    // Convert to JPEG base64
    const dataUrl = this.canvas.toDataURL('image/jpeg', 0.8);
    return dataUrl.split(',')[1]; // Return only the base64 part
  }
}
