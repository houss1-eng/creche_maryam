# Jardin d'enfants Abrar – École préparatoire · Android, iOS + PostgreSQL

Application de l'école préparatoire : **Administration** et **Espace Parents**.

```
📱 App Android / iPhone / navigateur  →  🟢 API Node.js (server/)  →  🐘 PostgreSQL
```

L'administration fait l'appel, envoie le cours du jour et le travail à la maison (photos prises avec le téléphone) :
les parents le reçoivent tout de suite, avec une notification sur leur téléphone.

```
www/              ← l'application (HTML / CSS / JS) — config.js = adresse du serveur
server/           ← API Express + PostgreSQL (index.js, schema.sql, seed.js, .env)
docker-compose.yml← base PostgreSQL (port 5435)
android/  ios/    ← projets natifs (Capacitor 7)
build-apk.ps1     ← construit LaMarelle.apk
```

Comptes de démo (mot de passe `1234`) : `admin@ecole.tn`,
parents : `20 100 200` (père de 3 enfants), `50 100 200` (mère), `20 300 400`, `50 700 800`.

---

## 1. Démarrer le serveur (sur le PC)

Prérequis : Docker Desktop lancé, Node.js 20+.

```powershell
npm install        # la première fois
npm run dev        # lance PostgreSQL (Docker) puis l'API sur http://localhost:3002
```

- Ouvrir **http://localhost:3002** dans le navigateur : l'application complète.
- Au premier démarrage, les tables sont créées et les comptes de démo ajoutés.
- Remettre la base à zéro : `cd server; node seed.js --reset`
- Une base de l'ancienne version (école primaire) n'est jamais modifiée automatiquement : le serveur s'arrête
  et indique la commande `node seed.js --reset` (qui efface tout).

### Autoriser les téléphones à se connecter (une seule fois)
Dans **PowerShell en administrateur** :
```powershell
New-NetFirewallRule -DisplayName "Jardin d'enfants Abrar API (port 3002)" -Direction Inbound -Protocol TCP -LocalPort 3002 -Action Allow
```

---

## 2. Tester sur les téléphones (même Wi-Fi que le PC)

L'adresse IP du PC est dans [www/config.js](www/config.js) (`API_MOBILE`, actuellement `http://172.20.10.2:3002`).
Si le PC change de réseau Wi-Fi, trouver la nouvelle IP avec `ipconfig`, la mettre dans `config.js`,
puis reconstruire l'APK.

- **Android** : installer `LaMarelle.apk` (le copier sur le téléphone et l'ouvrir).
  Reconstruire après une modification : `npm run apk`
- **iPhone** : ouvrir **Safari** → `http://<IP du PC>:3002` → Partager → « Sur l'écran d'accueil ».

---

## 3. Mise en production (accessible partout, 24h/24)

Le PC ne peut pas rester le serveur de l'école. Solution gratuite pour démarrer :

1. **Base PostgreSQL** en ligne : créer une base sur [neon.tech](https://neon.tech) (gratuit),
   copier l'URL de connexion (`postgres://...`).
2. **Serveur** sur [render.com](https://render.com) → *New Web Service* → dépôt GitHub du projet :
   - Build command : `npm install --prefix server`
   - Start command : `node server/index.js`
   - Variables d'environnement : `DATABASE_URL` = l'URL Neon, `DATABASE_SSL` = `true`,
     `JWT_SECRET` = une longue chaîne aléatoire.
3. Render donne une adresse **HTTPS** (ex. `https://lamarelle-fnll.onrender.com`) :
   - **iPhone et Android** : ouvrir cette adresse → « Sur l'écran d'accueil » / « Installer ».
   - **APK Android** : mettre cette adresse dans `API_MOBILE` (www/config.js) puis `npm run apk`.

---

## 4. Application iOS native (App Store)

Apple impose **un Mac avec Xcode** :
```bash
npm install
npm run open:ios        # synchronise puis ouvre Xcode → choisir l'équipe de signature → ▶ Run
```
Pour l'App Store : compte Apple Developer (99 $/an) et un serveur en **HTTPS** (étape 3).

---

## Fonctionnement

### Espace Parents (connexion avec le numéro de téléphone)
- L'élève (petit) n'a pas de compte. L'administration remplit son **profil** : photo, nom, classe, date de naissance,
  nom et numéro du père et de la mère, informations utiles (santé, allergies, qui vient le chercher…).
- À l'enregistrement, un **compte parent** est créé pour chaque numéro qui n'en a pas encore : identifiant **et** mot de passe
  = le numéro de téléphone (chiffres seuls, ex. `20100200`), avec un bouton 📋 pour copier le message à envoyer au parent par SMS.
  Le parent peut changer son mot de passe dans « Mon profil ».
- **Frères et sœurs** : un même numéro (père ou mère) sur plusieurs élèves = un seul compte qui voit tous ces enfants.
  Les numéros sont comparés sans espaces ni indicatif (`+216 20 100 200` = `20100200`), fonction SQL `tel_cle()`.
- Accueil : la photo de chaque enfant ; un appui ouvre ses cours du jour (menu : travail, absences, emploi du temps, cantine…).
  En haut des pages, les photos permettent de passer d'un enfant à l'autre.
- Mot de passe oublié : « Comptes parents » → 🔑 Mot de passe = numéro (il redevient le numéro de téléphone).

### Faire l'appel (administration)
- Classe, date, toute la journée ou un créneau ; chaque enfant est une tuile avec sa photo : un appui = absent (rouge).
- Chaque nouvelle absence → notification au père et à la mère. L'appel peut être refait : un enfant décoché
  redevient présent et les parents reçoivent une correction.
- La liste des absents affiche le numéro du père et de la mère (un appui = appel).

### Cours du jour et travail à la maison (administration)
- Classe, date, matière (proposées d'après les cours déjà envoyés), jusqu'à 8 photos (📷 appareil photo ou galerie, PDF accepté)
  et/ou un texte. Les photos sont réduites dans le téléphone avant l'envoi.
- Les parents de la classe reçoivent une notification et voient les publications classées par jour, photo en plein écran.

### Cantine scolaire
- **Administration** (page « Cantine », 2 onglets) :
  - *Menu de la semaine* : seulement la photo (ou le PDF) du menu → envoyée tout de suite à tous les parents avec une
    notification. Elle vaut pour la semaine en cours, du lundi au vendredi (pour la semaine suivante si elle est envoyée
    du vendredi au dimanche).
    Un nouveau menu **remplace automatiquement** l'ancien.
  - *Réservations* : les repas réservés, **jour par jour** (enfant, classe, parent qui a choisi), filtre par classe.
    Le tableau de bord affiche le nombre de repas du jour.
- **Parent** (page « Cantine ») : pour chaque enfant, touche les **jours** de la semaine du menu où il mange à la
  cantine, puis « Enregistrer » (« Tous les jours » en un appui). Un jour se change **jusqu'à la veille** ;
  l'administration reçoit une notification avec les jours choisis.

### Autres pages
- **Emplois du temps** : une photo (ou un PDF) par classe, prise avec le téléphone → envoyée tout de suite aux parents
  de la classe avec une notification. Une nouvelle photo remplace l'ancienne.
- **Événements** : publiés par l'administration → notification aux parents et à l'équipe.
- **Réclamations** : le parent écrit (enfant concerné, type, pièce jointe 📷 / 📎) à l'administration,
  qui répond ; la réponse arrive dans l'Espace Parents avec une notification.
- **Notes aux parents** (administration, page « Réclamations », onglet *Notes aux parents*, ou « 📒 Note aux parents »
  sur la fiche d'un élève) : type (comportement, santé, félicitations…), sujet, message, pièce jointe 📷 / 📎 → envoyée
  **seulement** aux parents de cet élève (père et mère), avec une notification ; ils la voient dans « Messages de l'école ».
- **Classes** : Classe A, Classe B, Classe C (ajout / suppression), liste PDF imprimable.
- **Administrateurs** : chaque administrateur peut ajouter, modifier ou supprimer les autres comptes (jamais le sien).
- Les anciens comptes « Direction » sont devenus des comptes Administration (même email, même mot de passe).

### Notifications dans la barre du téléphone
- Chaque notification (absence, cours, travail, événement, réponse…) part aussi dans la barre de notifications,
  même application fermée (`server/push.js`). Activation : bouton « 🔔 Activer les notifications » (accueil des parents,
  « Notifications » ou « Mon profil »).
- **iPhone** (iOS 16.4+) : depuis l'app ajoutée à l'écran d'accueil (Safari → Partager → « Sur l'écran d'accueil »).
- **Android / ordinateur** : Chrome, Edge… (site, ou application installée depuis le navigateur).
- **APK Android** : Firebase Cloud Messaging, préparé mais inactif tant que Firebase n'est pas configuré :
  1. [console.firebase.google.com](https://console.firebase.google.com) → nouveau projet → ajouter une app Android
     `tn.ecole.lamarelle` → télécharger `google-services.json` dans `android/app/`.
  2. Paramètres du projet → Comptes de service → « Générer une nouvelle clé privée » → copier tout le JSON
     dans la variable `FIREBASE_SERVICE_ACCOUNT` sur Render.
  3. `window.PUSH_NATIF = true` dans `www/config.js`, puis `npm run apk`.

## API (résumé)

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/login` (`identifiant` = email ou numéro de téléphone) | tous |
| GET | `/api/data` | tous (données filtrées : un parent ne reçoit que ses enfants) |
| POST/PATCH/DELETE | `/api/eleves` (formulaire + photo) → crée les comptes parents | administration |
| POST | `/api/parents/:id/mot-de-passe` | administration |
| POST | `/api/appel` → notifie les parents | administration |
| POST/DELETE | `/api/publications` (type `cours` / `travail`, photos) → notifie les parents de la classe | administration |
| POST/DELETE | `/api/emplois` (classe + photo de l'emploi du temps) → notifie les parents de la classe | administration |
| POST/PATCH/DELETE | `/api/classes`, `/api/evenements` | administration |
| POST/PATCH/DELETE | `/api/users` (administrateurs) | administration |
| POST | `/api/reclamations` (formulaire + pièce jointe) | parent |
| PATCH | `/api/reclamations/:id/traiter` (réponse optionnelle) | administration |
| POST/DELETE | `/api/notes-eleves` (note sur un élève + pièce jointe) → ses parents | administration |
| PUT | `/api/cantine/reservations` (jours de cantine d'un enfant, semaine du menu) | parent |
| POST/DELETE | `/api/cantine/menus` (photo du menu, remplace l'ancien) → tous les parents | administration |
| GET | `/api/fichiers/:id` | lien non devinable (UUID) |
