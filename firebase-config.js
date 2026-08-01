// Configurația publică a proiectului Firebase (delivery-app-ro-d24aa). Această cheie nu e un
// secret — accesul e controlat de regulile de securitate Firestore (firestore.rules), nu de
// ascunderea acestei valori. Trebuie încărcat înainte de app.js/curier.js.
const firebaseConfig = {
  apiKey: "AIzaSyCGdH9RtmZLfX90rXjuaauM1F3b9kM3ZsA",
  authDomain: "delivery-app-ro-d24aa.firebaseapp.com",
  projectId: "delivery-app-ro-d24aa",
  storageBucket: "delivery-app-ro-d24aa.firebasestorage.app",
  messagingSenderId: "774258962600",
  appId: "1:774258962600:web:950fd5bc45415f4260129d"
};
firebase.initializeApp(firebaseConfig);
