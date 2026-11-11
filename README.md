# Kiosque

Ton édition du matin, composée à partir de plusieurs journaux (français, portugais du Brésil, italien, anglais).
Glisse à droite pour garder un article, à gauche pour le passer ; les articles gardés t'attendent dans « À lire ».

## Comment ça marche

- `sources.json` : la liste des journaux et de leurs flux RSS (ajouter un journal = ajouter une ligne).
- `scripts/collect.ps1` : relève les flux et écrit `data/pool.json` (les articles des dernières 36 h).
- L'application (`index.html`, `app.js`, `styles.css`) compose chaque matin une édition fixe à partir de
  `pool.json` et de tes réglages, puis la garde sur le téléphone pour la journée.
- `.github/workflows/edition.yml` : chaque matin vers 5 h 15, GitHub relève les journaux et republie l'app.

Tes réglages, tes choix et ta liste « À lire » restent sur ton téléphone : rien n'est envoyé ailleurs.

## Tester sur l'ordinateur

```powershell
.\scripts\collect.ps1     # relève les journaux
.\scripts\serve.ps1       # puis ouvrir http://localhost:8765
```

## Journaux retirés (flux indisponibles en novembre 2026)

- Il Post : bloque volontairement les lecteurs automatiques.
- Avvenire : plus de flux RSS.
- Les Échos : flux refusé (erreur 403/503).
