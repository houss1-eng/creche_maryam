/* =========================================================
   Documents PDF (pdfkit) : liste des élèves d'une classe
   Polices standard (Helvetica) : accents français OK, pas d'emoji.
   Texte en arabe (noms de classes, d'élèves) : police Amiri (dossier polices/).
   ========================================================= */
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// Couleurs de la Crèche et jardin d'enfants Maryam : bleu nuit + les couleurs du logo (vert, bleu ciel, rouge, jaune, orange, violet)
const BLEU = '#2a6bb8', NUIT = '#1d2b5e', GRIS = '#4f5a70', TRAIT = '#dbe4f1', FOND = '#f4f7fd';
const CASES = ['#7cb83a', '#22abda', '#d3181c', '#f2c230', '#f08a1c', '#8a45c0'];
const LOGO = fileURLToPath(new URL('./logo.png', import.meta.url));
const MARGE = 40;
const ARABE = fileURLToPath(new URL('./polices/Amiri-Regular.ttf', import.meta.url));
const ARABE_GRAS = fileURLToPath(new URL('./polices/Amiri-Bold.ttf', import.meta.url));

// Police selon le texte : Amiri s'il contient de l'arabe (espaces entre les mots \u00E9largis), sinon Helvetica
const arabe = texte => /[\u0600-\u06FF]/.test(String(texte ?? ''));
const police = (doc, texte, gras = false) =>
  doc.font(arabe(texte) ? (gras ? 'Arabe-Gras' : 'Arabe') : (gras ? 'Helvetica-Bold' : 'Helvetica'));
const espaceMots = texte => (arabe(texte) ? 3 : 0);

// Espaces insécables du format français → espace simple (absents des polices standard)
const net = t => String(t ?? '').replace(/[  ]/g, ' ');
const aujourdhui = () => net(new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Tunis' }));

function nouveauDocument(res, nomFichier, titre, layout = 'portrait') {
  const doc = new PDFDocument({ size: 'A4', layout, margin: MARGE, bufferPages: true, info: { Title: titre, Author: "Crèche et jardin d'enfants Maryam" } });
  res.setHeader('Content-Type', 'application/pdf');
  doc.registerFont('Arabe', ARABE);
  doc.registerFont('Arabe-Gras', ARABE_GRAS);
  // Nom en arabe : « filename » en ASCII, « filename* » avec le vrai nom
  res.setHeader('Content-Disposition',
    `inline; filename="${nomFichier.replace(/[^\w.-]+/g, '_')}"; filename*=UTF-8''${encodeURIComponent(nomFichier)}`);
  res.setHeader('Cache-Control', 'no-store');
  doc.pipe(res);
  return doc;
}

function entete(doc, titre, sousTitre) {
  const l = doc.page.width;
  doc.rect(0, 0, l, 70).fill(NUIT);
  // Bande des 6 cases de la marelle sous l'en-tête
  CASES.forEach((c, i) => doc.rect(i * l / CASES.length, 70, l / CASES.length + 1, 4).fill(c));
  // Logo de l'école dans un carré blanc arrondi
  let x = MARGE;
  if (existsSync(LOGO)) {
    doc.roundedRect(MARGE - 1, 8, 54, 54, 8).fill('#ffffff');
    doc.image(LOGO, MARGE + 1, 10, { fit: [50, 50], align: 'center', valign: 'center' });
    x = MARGE + 64;
  }
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text("Crèche et jardin d'enfants ", x, 18, { continued: true })
    .fillColor('#f2c230').text('Maryam');
  doc.font('Helvetica').fontSize(9).fillColor('#d3daf3').text("Crèche et jardin d'enfants Maryam · École préparatoire", x, 42);
  doc.fontSize(9).text(`Édité le ${aujourdhui()}`, MARGE, 42, { width: l - 2 * MARGE, align: 'right' });
  police(doc.fillColor(NUIT), titre, true).fontSize(16).text(titre, MARGE, 90, { wordSpacing: espaceMots(titre) });
  if (sousTitre) doc.font('Helvetica').fontSize(10).fillColor(GRIS).text(sousTitre, MARGE, doc.y + 2);
  doc.moveDown(1);
}

// Numéros de page en bas de chaque page
function piedDePage(doc) {
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(i);
    const bas = doc.page.height - 28;
    doc.page.margins.bottom = 0;
    doc.fontSize(8).fillColor(GRIS).font('Helvetica')
      .text(`Crèche et jardin d'enfants Maryam · page ${i + 1} / ${pages.count}`, MARGE, bas, { width: doc.page.width - 2 * MARGE, align: 'center' });
  }
}

function sousTitreSection(doc, texte) {
  place(doc, 40);
  doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor(NUIT).text(texte, MARGE);
  doc.moveDown(0.3);
}

// Nouvelle page si la place manque
function place(doc, hauteur) {
  if (doc.y + hauteur > doc.page.height - MARGE - 20) { doc.addPage(); doc.y = MARGE; }
}

// Tableau : colonnes [{ titre, largeur (fraction), align }], lignes [[...]] ; en-tête répété sur chaque page
function tableau(doc, colonnes, lignes, { total, couleurs } = {}) {
  const largeurTotale = doc.page.width - 2 * MARGE;
  const larg = colonnes.map(c => c.largeur * largeurTotale);
  const H = 20;
  const ligne = (cellules, y, style) => {
    let x = MARGE;
    if (style.fond) doc.rect(MARGE, y, largeurTotale, H).fill(style.fond);
    cellules.forEach((c, i) => {
      police(doc, c, style.gras).fontSize(style.taille || 9)
        .fillColor(style.couleurs?.[i] || style.couleur || '#1e293b')
        .text(net(c), x + 5, y + 6, { width: larg[i] - 10, align: colonnes[i].align || 'left', lineBreak: false, ellipsis: true,
          wordSpacing: espaceMots(c) });
      x += larg[i];
    });
    doc.moveTo(MARGE, y + H).lineTo(MARGE + largeurTotale, y + H).lineWidth(0.5).strokeColor(TRAIT).stroke();
  };
  // doc.text() déplace doc.y : on part toujours de la position mémorisée avant la ligne
  const ecrire = (cellules, style) => { const y = doc.y; ligne(cellules, y, style); doc.y = y + H; };
  const titres = () => { place(doc, H * 2); ecrire(colonnes.map(c => c.titre), { fond: '#e8eeff', gras: true, couleur: '#334155', taille: 8.5 }); };
  titres();
  lignes.forEach((l, k) => {
    if (doc.y + H > doc.page.height - MARGE - 20) { doc.addPage(); doc.y = MARGE; titres(); }
    ecrire(l, { fond: k % 2 ? '#fafbff' : null, couleurs: couleurs?.[k] });
  });
  if (total) { place(doc, H); ecrire(total, { fond: FOND, gras: true }); }
  doc.x = MARGE;
  doc.moveDown(0.5);
}

// ================= LISTE DES ÉLÈVES D'UNE CLASSE =================
export function pdfListeClasse(res, { classe, eleves }) {
  const d = new Date(), an = d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
  const doc = nouveauDocument(res, `liste-${classe.replace(/\s+/g, '-')}.pdf`, `Liste des élèves — ${classe}`);
  entete(doc, classe, `Liste des élèves · ${eleves.length} élève(s) · Année scolaire ${an}-${an + 1}`);
  if (!eleves.length) {
    doc.font('Helvetica-Oblique').fontSize(11).fillColor(GRIS).text('Aucun élève dans cette classe.', MARGE);
  } else {
    tableau(doc, [
      { titre: 'N°', largeur: 0.07, align: 'center' },
      { titre: 'Nom et prénom', largeur: 0.30 },
      { titre: 'Né(e) le', largeur: 0.13 },
      { titre: 'Tél. père', largeur: 0.17 },
      { titre: 'Tél. mère', largeur: 0.17 },
      { titre: 'Observations', largeur: 0.16 }
    ], eleves.map((e, i) => [i + 1, e.nom, e.naissance || '—', e.tel_pere || '—', e.tel_mere || '—', '']));
  }
  piedDePage(doc);
  doc.end();
}
