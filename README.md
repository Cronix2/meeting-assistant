# Desk Assistant

Petite appli Windows 11 (Electron + TypeScript) qui écoute l'audio de ton bureau, le transcrit en direct et te propose la réponse à donner, dans une petite fenêtre discrète.

1. **Écoute l'audio de toutes tes applis** en même temps (loopback Windows, ou mixeur multi-sorties pour SteelSeries Sonar).
2. **Transcrit en temps réel** avec ElevenLabs **Scribe v2 Realtime** (français et anglais, détection automatique).
3. Envoie la conversation récente à **Claude** (streaming, `claude-haiku-5-5` par défaut).
4. Affiche la réponse dans une **fenêtre toujours au premier plan**, **absente de la barre des tâches**, que l'on ouvre/ferme avec un **raccourci global**.

## Installer (sans rien compiler)

1. Va dans l'onglet **Releases** du dépôt et télécharge `DeskAssistant-Setup-x.y.z.exe`.
2. Lance-le. L'installeur n'est **pas signé** : Windows SmartScreen affichera « Windows a protégé votre ordinateur » → *Informations complémentaires* → *Exécuter quand même*.
3. Ouvre les **Réglages** (⚙ dans la fenêtre, ou l'icône de la zone de notification) et colle tes clés API :
   - une clé **ElevenLabs** (permission *Speech to Text*),
   - une clé **Anthropic** (Claude).

Les clés sont chiffrées sur ton PC (DPAPI via `safeStorage`) et ne sont jamais envoyées aux pages de l'appli.

## Utilisation

| Action | Raccourci par défaut |
|---|---|
| Afficher / masquer la fenêtre | `Ctrl+Alt+Espace` |
| Demander une réponse à Claude | `Ctrl+Alt+Entrée` |
| Vider transcription, réponses et mémoire de conversation | `Ctrl+Alt+Retour arrière` |

Tous les raccourcis sont modifiables dans les Réglages.

- **Mode manuel** (défaut) : l'écoute tourne en continu, Claude répond quand tu demandes (⚡ ou raccourci).
- **Mode auto** : réponse aux questions dès qu'elles sont reconnues (option « réponse anticipée » : Claude démarre avant la validation de la phrase). Il répond « — » quand il n'y a rien à dire.
- Fermer la fenêtre (✕) la **masque** sans arrêter l'écoute. Pour quitter : icône de la zone de notification → Quitter.
- La fenêtre est exclue des captures et partages d'écran (désactivable).
- Le petit **⏱** de la barre indique le délai avant le premier mot de la réponse ; le détail est dans le journal des Réglages.

## Fonctions principales

- **Mixeur de sorties Windows** (SteelSeries Sonar…) : un petit helper natif (`helper/LoopbackMixer.cs`) écoute en loopback chaque canal Sonar (Game, Chat, Média, Aux) en même temps, sans mode Streamer. Il est compilé au premier usage avec `csc.exe`, fourni avec Windows (rien à installer).
- **Mémoire personnelle (RAG local)** : un profil permanent + des documents (`.txt`, `.md`, `.json`, `.csv`…) dont les extraits les plus proches de la conversation (classement BM25) sont ajoutés à chaque demande.
- **Mémoire de conversation** : les réponses déjà données sont replacées dans l'historique envoyé à Claude, pour qu'il ne se répète pas et reste cohérent.
- **Contexte de session & jeu de rôle** : Claude repère les mises en situation (exercices, entretiens simulés) et répond comme ton personnage ; un champ « contexte » permet de le forcer.
- **Nombres, dates et heures en toutes lettres** (désactivable).
- **Panneau Diagnostic en direct** dans les Réglages : niveaux par sortie audio, états capture / transcription, journal.
- Prompt système personnalisable (presets : général, jeu de rôle, réunion, entretien, cours, traduction).

## Données et confidentialité

Le dépôt ne contient **aucune clé ni donnée personnelle**. Tout ce qui est propre à ton usage vit sur ton PC, dans `%APPDATA%\Desk Assistant` :

| Fichier | Contenu |
|---|---|
| `secrets.json` | tes clés API, chiffrées avec DPAPI (illisibles hors de ta session Windows) |
| `settings.json` | tes réglages (prompt, raccourcis, profil de la mémoire…) |
| `rag.json` | le texte des documents que tu ajoutes à la mémoire |
| `helper/` | l'exécutable du mixeur compilé localement |

- **Ce qui part sur le réseau** : l'audio vers ElevenLabs ; la transcription récente, tes réponses précédentes, ton profil et les extraits de documents retenus vers l'API Anthropic. Évite d'y mettre ce que tu ne veux pas envoyer à ces services.
- La transcription reste en mémoire vive (jamais écrite sur disque).
- Informe les participants d'un appel avant de l'utiliser dessus.
- Le texte transcrit est traité comme des données non fiables (anti-injection de prompt) ; Claude n'a de toute façon aucun outil ici.

## Développer

Prérequis : Windows 11, Node.js 20+ (22 recommandé).

```powershell
npm install
npm run dev          # lance l'appli en mode développement
npm run typecheck
npm run dist         # construit l'installeur dans dist/
```

Repli pour le développement : variables d'environnement `ELEVENLABS_API_KEY` et `ANTHROPIC_API_KEY` (voir `.env.example`), utilisées si aucune clé n'est enregistrée dans les Réglages.

### Publier une version

```powershell
# 1. mettre à jour "version" dans package.json, puis :
git tag v0.1.0
git push origin v0.1.0
```

Le workflow GitHub Actions `Release Windows` construit l'installeur sur un runner Windows et l'attache à la Release correspondante. Il peut aussi être lancé à la main (*Actions → Release Windows → Run workflow*) : l'installeur est alors disponible comme artefact du run.

## Structure

```
src/main/       index (bootstrap + IPC), pipeline (cerveau), stt (Scribe), llm (Claude), rag (mémoire),
                helper (mixeur natif), gate (silence), windows, shortcuts, tray, settings, buffer, log
src/preload/    pont IPC à liste blanche de canaux
src/renderer/   capture/ (page cachée, audio) · overlay/ · settings/
src/shared/     types, valeurs par défaut, presets
helper/         LoopbackMixer.cs (capture WASAPI multi-sorties, compilée au premier usage)
```

## Dépannage

| Symptôme | Piste |
|---|---|
| Rien n'est transcrit | Ouvre le **Diagnostic** des Réglages : une barre doit monter quand du son joue. Sinon choisis la source « Mixeur de sorties Windows », ou baisse le seuil de détection du son. |
| « ElevenLabs : HTTP 401 » / `auth_error` | Clé ElevenLabs invalide (colle la clé secrète `sk_…`, pas son identifiant) ou sans la permission *Speech to Text*. |
| Pas d'usage visible dans la console Anthropic | Compare les 4 derniers caractères affichés dans les Réglages avec ta liste de clés, et vérifie l'organisation / le workspace sélectionné. |
| « Modèle Claude introuvable » | Corrige l'identifiant du modèle dans les Réglages. |
| Raccourci refusé | Combinaison déjà prise par une autre appli : en choisir une autre. |

## Limites connues

- Ta propre voix (micro) n'est pas captée : seule la sortie audio l'est.
- Pas de séparation des locuteurs, pas de mise à jour automatique.
- Installeur non signé (avertissement SmartScreen) et icône Electron par défaut.
- Le mixeur nécessite Windows et son compilateur C# intégré (`csc.exe`, présent par défaut).
