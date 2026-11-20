# RR Streaming

Lecteur multimédia personnel avec une interface inspirée de tvOS. Le catalogue (affiches, synopsis, saisons, épisodes) vient de **TMDB**. Les **sources** ajoutées par l'utilisateur servent uniquement à trouver le flux vidéo d'un titre au moment de la lecture.

RR Streaming ne contient et ne fournit aucun contenu : la lecture dépend uniquement des sources configurées par l'utilisateur.

## Installation (Windows)

1. Téléchargez `RR-Streaming-Setup-x.y.z.exe` depuis la page [Releases](https://github.com/RobinRahoual/RR-Streaming/releases/latest).
2. L'installateur n'est pas signé : Windows SmartScreen affiche « Windows a protégé votre ordinateur ». Cliquez sur **Informations complémentaires → Exécuter quand même**.
3. Au premier lancement, ouvrez **Réglages** et collez votre clé API TMDB (gratuite : themoviedb.org → Paramètres → API).
4. La première ouverture de l'onglet **Sources** démarre le serveur compagnon : autorisez RR Streaming dans le pare-feu Windows (réseaux privés) pour pouvoir y accéder depuis un téléphone.

Les mises à jour sont automatiques : l'application vérifie GitHub Releases au démarrage puis toutes les 4 h, télécharge la nouvelle version en arrière-plan et l'installe à la fermeture (ou tout de suite avec « Redémarrer »).

## Fonctionnement

```
Catalogue TMDB ──► Fiche (film / épisode) ──► Lire
                                               │
           Sources actives, par priorité ◄─────┘
           1. recherche du titre sur la source (sélecteurs CSS du JSON)
           2. choix du meilleur résultat (similarité du titre + année)
           3. page de l'épisode (séries), puis iframe du lecteur si définie
           4. fenêtre invisible : interception réseau des .m3u8 / .mpd / .mp4
              + headers (Referer, Origin, User-Agent, Cookie), pubs et redirections bloquées
           5. lecture HLS (hls.js), DASH (dash.js) ou MP4, headers rejoués sur chaque segment
```

### Animes

TMDB ne distingue pas les animes : RR Streaming les reconnaît (genre Animation, langue d'origine japonaise). Un onglet **Animes** du catalogue les regroupe. Une source cochée **Animes** est essayée en premier pour ces titres ; une source « Animes » seule n'est pas utilisée pour les autres films et séries.

### Préparation du flux

Dès l'ouverture d'une fiche, RR Streaming cherche le flux en arrière-plan (« Recherche d'une source… » puis « Prêt à lire · source ») : le bouton « Lire » démarre alors presque instantanément. Pour une série, l'épisode proposé par « Lire » est préparé, ainsi que l'épisode survolé. Dans la recherche, chaque résultat indique s'il est **Disponible** ou **Introuvable** sur vos sources : RR Streaming fait une seule recherche par source avec le texte tapé et y compare tous les résultats, puis vérifie individuellement les premiers titres non trouvés (titres alternatifs TMDB compris, utiles pour les noms romaji des animes). Un flux préparé reste valable 8 minutes ; s'il a expiré entre-temps, il est recherché à nouveau automatiquement.

### Ajouter une source (assistant)

Onglet **Sources → + Ajouter une source** : l'assistant s'ouvre directement dans l'application (aucun serveur ni navigateur). Depuis un téléphone, « Afficher le QR code » ouvre le même assistant sur le téléphone. L'assistant se fait en cinq étapes, sans JSON ni CSS :

1. **Site** : nom, adresse, films, séries et/ou animes, langue.
2. **Recherche** : chercher un mot sur le site et coller l'adresse de la page de résultats ; le modèle de recherche est déduit automatiquement.
3. **Résultats** : RR Streaming analyse la page et propose les listes détectées (affiche, titre, année) ; il suffit de toucher la bonne.
4. **Séries** : coller l'adresse d'une série et d'un de ses épisodes ; le modèle d'adresse des épisodes est déduit.
5. **Lecteur** (facultatif) : coller une page de lecture ; l'iframe du lecteur est repérée, bandes-annonces et publicités écartées.

Un récapitulatif permet ensuite de choisir la priorité et de **tester la recherche** avec un vrai titre avant d'enregistrer. « Modifier » rouvre l'assistant sur une source existante. Le mode avancé (JSON) reste disponible.

### Sources

- **Listes** : URL d'un fichier JSON (format décrit dans [`docs/sources.schema.json`](docs/sources.schema.json), exemple dans [`docs/sources.example.json`](docs/sources.example.json)). Synchronisation avec ETag ; une liste en erreur garde ses anciennes sources.
- **Sources locales** : ajoutées depuis la page compagnon ou importées depuis un fichier. Une source locale remplace celle d'une liste qui a le même `id`.
- **Page compagnon (facultative)** : « Afficher le QR code » dans l'onglet Sources démarre un serveur local et affiche un QR code et un code à 6 chiffres. Depuis un téléphone sur le même réseau, on ajoute, modifie ou supprime des sources. Le serveur s'arrête avec « Arrêter » ou en quittant l'onglet.

### Interface

Inspirée de l'app Apple TV : barre latérale repliée qui s'ouvre quand on y entre (flèche gauche ou « Retour » depuis une page principale), focus blanc, police système. L'accueil montre un carrousel des tendances avec les titres suivants à droite, puis **À suivre** (titres commencés, reprise directe) et **Ma liste** (« + » sur un titre). Une fiche propose ses autres images dans la colonne **Scènes**. Le fond de la fenêtre reprend, flouté, l'image affichée.

### Raccourcis

| Touche | Action |
|---|---|
| Flèches | Déplacer le focus (comme une télécommande) |
| Entrée | Valider |
| Échap / Retour arrière | Retour |
| Espace | Lecture / pause |
| ← / → (lecteur, contrôles masqués) | −10 s / +10 s |
| F | Plein écran |

## Développement

```bash
npm install
npm start          # lance l'application
npm test           # tests (validation, scraping, résolveur, dépôt, serveur compagnon)
npm run dist       # construit l'installateur Windows dans dist/ (sous Windows)
```

```
src/main/            Processus principal Electron
  sources/           Validation, dépôt (listes + locales), scraping et correspondance des titres
  resolver/          Fenêtre d'interception réseau + pipeline TMDB → flux
  companion/         Serveur HTTP local + QR code
  tmdb.js            Client TMDB (clé v3 ou jeton v4)
  updater.js         Mises à jour automatiques (electron-updater + GitHub Releases)
src/renderer/        Interface (Accueil, Films, Séries, Recherche, fiches, Sources, Réglages, lecteur)
src/companion/       Page web compagnon (partagée avec la version Fire TV)
android/             Version Fire TV : modules Kotlin, Gradle, manifest (voir android/README.md)
docs/                Schéma JSON des sources
```

## Publier une nouvelle version

1. Mettre à jour `version` dans `package.json` (ex. `0.2.0`) et pousser sur `main`.
2. Au choix :
   - GitHub → **Actions → Release Windows → Run workflow** (le tag `v0.2.0` est créé automatiquement) ;
   - ou `git tag v0.2.0 && git push origin v0.2.0`.
3. Le workflow **Release Windows** construit l'installateur sur `windows-latest` et le publie dans une Release GitHub avec `latest.yml`. Les installations existantes se mettent à jour automatiquement.

---

Ce produit utilise l'API TMDB mais n'est ni approuvé ni certifié par TMDB.
