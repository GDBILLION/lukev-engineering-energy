# LUKEV Engineering & Energy — React/TypeScript package

## Run locally
1. Install Node.js 20+.
2. In this folder run `npm install`.
3. Run `npm run dev` and open the local URL Vite prints.
4. Run `npm run build` for a production build.

## Migration note
The React/TypeScript entry point currently hosts the supplied original page in an iframe. This preserves the original HTML/CSS/JavaScript behavior—including its existing reveal animations, responsive menu, gallery/lightbox, WhatsApp links, and inquiry form behavior—without claiming these have been reimplemented as React components. This is a compatibility-first bridge, not a completed native React migration. The original page uses Tailwind's CDN and remote Unsplash images.

## Cinematic reveal timing update

The existing scroll reveal implementation has been refined without adding an animation library or changing the Intersection Observer trigger. The main reveal now runs for 1.45 seconds with a smooth ease-out curve; grouped direct children use a 1.25-second transition with a subtle stagger. The existing reduced-motion preference is also applied to the staggered children so content appears immediately when the visitor requests reduced motion.

### Updating an existing installation

If you already have this project installed, replace **`public/original.html`** with the `public/original.html` file from this ZIP. Keep the rest of your project and assets unchanged.

If you are installing this ZIP for the first time, extract it and run `npm install`, then `npm run dev` (or `npm run build` for a production build).
