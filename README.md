# Kiosque

Ton édition du matin, composée à partir de plusieurs journaux (français, portugais du Brésil, italien, anglais).
Glisse à droite pour garder un article, à gauche pour le passer ; les articles gardés t'attendent dans « À lire ».

## Comment ça marche

- `sources.json` : la liste des journaux et de leurs flux RSS (ajouter un journal = ajouter une ligne).
- `scripts/collect.ps1` : relève les flux et écrit `data/pool.json` (les articles des dernières 36 h).
- `scripts/articles/extract.mjs` : télécharge chaque article de `pool.json` et en garde le texte
  (`data/articles/<id>.json`) pour la lecture hors connexion.
- L'application (`index.html`, `app.js`, `styles.css`) compose chaque matin une édition fixe à partir de
  `pool.json` et de tes réglages, puis la garde sur le téléphone pour la journée.
- `.github/workflows/edition.yml` : chaque matin vers 5 h 15, GitHub relève les journaux et republie l'app.

Tes réglages, tes choix et ta liste « À lire » restent sur ton téléphone : rien n'est envoyé ailleurs.

## Lire sans réseau

Quand tu gardes un article, l'app télécharge tout de suite son texte et ses images sur le téléphone
(il faut donc avoir du réseau à ce moment-là, par exemple en triant l'édition avant de partir).
Dans « À lire », les articles marqués « Hors ligne » s'ouvrent dans la liseuse de l'app, même dans le train.
Pour les articles réservés aux abonnés, seul le début est enregistré (« Début hors ligne ») :
la suite reste à lire sur le site une fois connecté.

## Tester sur l'ordinateur

```powershell
.\scripts\collect.ps1     # relève les journaux
cd scripts\articles; npm ci; node extract.mjs; cd ..\..   # (facultatif, demande Node.js) textes hors connexion
.\scripts\serve.ps1       # puis ouvrir http://localhost:8765
```

## Journaux retirés (flux indisponibles en novembre 2026)

- Il Post : bloque volontairement les lecteurs automatiques.
- Avvenire : plus de flux RSS.
- Les Échos : flux refusé (erreur 403/503).
