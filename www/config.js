/* =========================================================
   Adresse du serveur API Jardin d'enfants Abrar
   ---------------------------------------------------------
   - Dans le navigateur (PC, iPhone, Android) l'application est servie par le serveur
     lui-même : on laisse vide, l'API est à la même adresse.
   - Dans l'application installée (APK Android / app iOS), il faut l'adresse complète :
       • tests sur le Wi-Fi : http://<IP du PC>:3000   (le PC et le téléphone sur le même Wi-Fi)
       • en production     : https://votre-serveur.onrender.com
   Après modification : npm run apk (Android) / npm run open:ios (iOS)
   ========================================================= */
const API_MOBILE = 'https://lamarelle-fnll.onrender.com';   // tests en local : 'http://172.20.10.2:3002'

window.API_URL = window.Capacitor && window.Capacitor.isNativePlatform() ? API_MOBILE : '';

// Notifications Android de l'APK (Firebase) : passer à true une fois android/app/google-services.json ajouté
// (et FIREBASE_SERVICE_ACCOUNT renseigné sur le serveur). L'iPhone et le navigateur utilisent Web Push, sans Firebase.
window.PUSH_NATIF = false;
