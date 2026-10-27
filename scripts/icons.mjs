// Génère toutes les images de l'application à partir du logo de l'école (assets/logo-source.jpg) :
// icônes PWA (www/icons), logo de l'interface (www/img), logo des PDF (server), sources Capacitor (assets/)
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';

const SOURCE = 'assets/logo-source.jpg';
const BLANC = { r: 255, g: 255, b: 255, alpha: 1 };
const CREME = { r: 255, g: 254, b: 250, alpha: 1 };   // fond des cartes de l'application (#fffefa)
const VIDE = { r: 0, g: 0, b: 0, alpha: 0 };
mkdirSync('www/icons', { recursive: true });
mkdirSync('www/img', { recursive: true });

// Logo sans les grandes marges blanches de l'image d'origine, et sans son fond blanc
// (« couleur vers alpha » : le blanc devient transparent, les bords restent doux)
const decoupe = await sharp(SOURCE).trim({ background: '#ffffff', threshold: 30 }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const sansFond = Buffer.alloc(decoupe.info.width * decoupe.info.height * 4);
for (let k = 0; k < decoupe.info.width * decoupe.info.height; k++) {
  const c = [decoupe.data[k * 3], decoupe.data[k * 3 + 1], decoupe.data[k * 3 + 2]];
  const a = (255 - Math.min(...c)) / 255;
  for (let j = 0; j < 3; j++) sansFond[k * 4 + j] = a ? Math.round((c[j] - (1 - a) * 255) / a) : 0;
  sansFond[k * 4 + 3] = Math.round(a * 255);
}
const LOGO = await sharp(sansFond, { raw: { width: decoupe.info.width, height: decoupe.info.height, channels: 4 } }).png().toBuffer();
const logo = (size, fond = CREME) => sharp(LOGO).resize(size, size, { fit: 'contain', background: VIDE }).flatten({ background: fond });
// Logo centré sur un carré (crème par défaut), avec une marge (icônes « maskable » et Android : rien n'est coupé)
const avecMarge = async (taille, logoTaille, fond = CREME) => sharp({ create: { width: taille, height: taille, channels: 4, background: fond } })
  .composite([{ input: await sharp(LOGO).resize(logoTaille, logoTaille, { fit: 'contain', background: VIDE }).png().toBuffer(), gravity: 'center' }]);

// Navigateur / PWA
await logo(192).png().toFile('www/icons/icon-192.png');
await logo(512).png().toFile('www/icons/icon-512.png');
await (await avecMarge(512, 400)).png().toFile('www/icons/icon-maskable-512.png');
// Interface (menu) sur fond crème ; PDF (imprimé) sur fond blanc
await logo(320).png({ compressionLevel: 9 }).toFile('www/img/logo.png');
await logo(300, BLANC).png({ compressionLevel: 9 }).toFile('server/logo.png');

// Sources Capacitor : icône adaptative Android = premier plan (logo transparent) + arrière-plan (crème)
await (await avecMarge(1024, 900)).png().toFile('assets/icon-only.png');
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: CREME } }).png().toFile('assets/icon-background.png');
await (await avecMarge(1024, 620, VIDE)).png().toFile('assets/icon-foreground.png');

// Écran de démarrage : fond crème + logo au centre
for (const nom of ['splash.png', 'splash-dark.png']) await (await avecMarge(2732, 1000)).png().toFile('assets/' + nom);
console.log('Images générées à partir du logo ✔');

// Petite icône des notifications (barre d'état) : le nom « MARYAM » (lettres colorées en haut du logo),
// en blanc sur fond transparent (Android n'affiche que la silhouette de cette icône)
const meta = await sharp(SOURCE).metadata();
const HAUT = Math.round(meta.height * 0.3);   // le nom est au-dessus des personnages
const { data, info } = await sharp(SOURCE).extract({ left: 0, top: 0, width: meta.width, height: HAUT })
  .removeAlpha().raw().toBuffer({ resolveWithObject: true });
const pixels = Buffer.alloc(info.width * info.height * 4, 255);
for (let k = 0; k < info.width * info.height; k++) {
  const [r, g, b] = [data[k * 3], data[k * 3 + 1], data[k * 3 + 2]];
  const couleur = Math.max(r, g, b) - Math.min(r, g, b);   // le fond blanc et les traits noirs ne sont pas colorés
  pixels[k * 4 + 3] = couleur > 80 ? 255 : couleur > 50 ? (couleur - 50) * 8 : 0;
}
const nom = await sharp(pixels, { raw: { width: info.width, height: info.height, channels: 4 } }).trim().png().toBuffer();
const badge = (taille, marge) => sharp(nom)
  .resize(taille - 2 * marge, taille - 2 * marge, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .extend({ top: marge, bottom: marge, left: marge, right: marge, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png();
await badge(96, 8).toFile('www/icons/badge-96.png');
for (const [dossier, taille] of [['mdpi', 24], ['hdpi', 36], ['xhdpi', 48], ['xxhdpi', 72], ['xxxhdpi', 96]]) {
  mkdirSync(`android/app/src/main/res/drawable-${dossier}`, { recursive: true });
  await badge(taille, Math.round(taille / 12)).toFile(`android/app/src/main/res/drawable-${dossier}/ic_stat_notif.png`);
}
console.log('Icône des notifications générée ✔');

// ---- Logo animé de la page de connexion : le logo de l'école seul, sur fond transparent ----
// (il flotte, saute et joue une mélodie quand on le touche : voir app.js et style.css)
{
  const L = await sharp(LOGO).metadata();
  const lw = Math.round(L.width * 0.6), lh = Math.round(L.height * 0.6);
  await sharp(LOGO).resize(lw).png({ compressionLevel: 9 }).toFile('www/img/marelle-texte.png');
  writeFileSync('www/marelle-cases.css', `/* Fichier généré par scripts/icons.mjs (npm run icons) : proportions du logo animé */\n`
    + `.logo-marelle { aspect-ratio: ${lw} / ${lh}; }\n`);
  console.log('Logo animé généré ✔');
}
