import type { ImageMetadata } from 'astro';

const images = import.meta.glob<{ default: ImageMetadata }>(
  '/src/assets/people/*.{jpg,jpeg,png,webp}',
  { eager: true },
);

/**
 * Resolve a photo path from members.json to an ImageMetadata object.
 * Paths like "/assets/people/ben.jpg" map to the glob key "/src/assets/people/ben.jpg".
 * External URLs (http/https) pass through as strings.
 */
export function resolvePhoto(photo: string): ImageMetadata | string {
  if (photo.startsWith('http://') || photo.startsWith('https://')) {
    return photo;
  }
  const key = `/src${photo}`;
  const match = images[key];
  if (match) {
    return match.default;
  }
  return photo;
}

export function isLocalImage(src: ImageMetadata | string): src is ImageMetadata {
  return typeof src !== 'string';
}
