/**
 * Aide de chaque réglage : sert à la fois aux boutons « ? » et à la visite guidée.
 * `what` = à quoi ça sert ; `fill` = quoi mettre ; `example` = exemple concret (bouton « Utiliser cet exemple »
 * quand `apply` vaut true et que le champ est un texte).
 */
export interface HelpEntry {
  title: string
  what: string
  fill?: string
  example?: string
  apply?: boolean
}

export const HELP: Record<string, HelpEntry> = {
  // ----- Clés -----
  elevenLabsKey: {
    title: 'Clé ElevenLabs',
    what: "ElevenLabs transforme le son en texte, en direct. Sans cette clé, rien n'est transcrit.",
    fill: "Sur elevenlabs.io : Settings → API Keys → Create. Donne-lui la permission « Speech to Text », puis colle la clé secrète (elle commence par sk_). L'identifiant de la clé ne marche pas.",
    example: 'sk_3f9a… (une longue suite de lettres et de chiffres)'
  },
  anthropicKey: {
    title: 'Clé Claude',
    what: "Claude lit la conversation et écrit la réponse proposée. Chaque demande consomme un peu de crédit sur ton compte Anthropic.",
    fill: 'Sur console.anthropic.com : Settings → API Keys → Create Key, puis colle la clé ici.',
    example: 'sk-ant-api03-… '
  },

  // ----- Écoute -----
  audioSource: {
    title: 'Son à écouter',
    what: "L'appli écoute ce qui sort de ton PC (Teams, Zoom, navigateur…), jamais ton micro.",
    fill: "« Sortie par défaut » suffit si tout ton son passe par un seul casque ou haut-parleur. Avec SteelSeries Sonar ou plusieurs sorties, choisis « Toutes les sorties (mixeur) » : chaque canal est écouté en même temps.",
    example: "Teams sort sur « Sonar – Chat » et YouTube sur « Sonar – Media » : choisis le mixeur pour entendre les deux."
  },
  sttLanguage: {
    title: 'Langue parlée',
    what: 'La langue des personnes que tu entends.',
    fill: "Laisse « Détecter » si la conversation mélange français et anglais. Fixe la langue si les transcriptions sortent dans la mauvaise.",
  },
  vadSilenceSecs: {
    title: 'Fin de phrase',
    what: "Durée de silence après laquelle une phrase est considérée comme terminée. C'est ce qui déclenche les réponses automatiques.",
    fill: "Autour de 0,5 s pour réagir vite. Monte vers 1 s si les phrases sont coupées en plein milieu (interlocuteur qui fait des pauses).",
  },
  autoListen: {
    title: 'Écouter au lancement',
    what: "L'écoute démarre dès que l'appli s'ouvre, sans avoir à appuyer sur ⏺.",
    fill: 'À activer si tu lances l’appli juste avant tes appels.'
  },
  silenceGate: {
    title: "N'envoyer que le son",
    what: "Les moments de silence ne sont pas envoyés à ElevenLabs : tu ne paies que l'audio utile.",
    fill: 'Laisse activé, sauf si des débuts de phrases manquent dans la transcription.'
  },
  gateThreshold: {
    title: 'Sensibilité au son',
    what: "Volume minimal pour considérer qu'il y a du son.",
    fill: "Déplace vers la gauche si des voix faibles sont ignorées, vers la droite si un bruit de fond (ventilateur, musique douce) est transcrit."
  },

  // ----- Réponses -----
  preset: {
    title: 'Type de situation',
    what: "Remplit les instructions données à Claude avec un style adapté : réponses d'entretien, notes de réunion, aide en cours, traduction…",
    fill: 'Prends le plus proche de ce que tu fais. Tu peux en changer à tout moment.',
    example: 'Entretien technique → « Entretien » ; exercice d’anglais avec un personnage → « Jeu de rôle ».'
  },
  sessionContext: {
    title: 'Ce que tu fais en ce moment',
    what: "Le contexte précis de la séance. Claude s'en sert pour comprendre qui parle et ce qu'on attend de toi.",
    fill: 'Qui sont les interlocuteurs, quel est le sujet, quel rôle tu joues. Deux ou trois phrases suffisent. Vide-le quand la situation change.',
    example:
      "Entretien d'embauche pour un poste de pentester junior chez un cabinet d'audit. Le recruteur me pose des questions techniques (web, réseau, Active Directory) et sur mon parcours. Je veux des réponses courtes que je peux dire à l'oral.",
    apply: true
  },
  mode: {
    title: 'Quand répondre',
    what: '« Quand je le demande » : rien ne part tant que tu ne cliques pas sur ⚡ ou ne fais pas le raccourci. « Tout seul » : une réponse arrive dès qu’une question est entendue.',
    fill: "Commence par « Quand je le demande » pour garder le contrôle. Passe en « Tout seul » quand tu as besoin d'aller vite."
  },
  replyLanguage: {
    title: 'Langue des réponses',
    what: 'La langue dans laquelle Claude te propose de répondre.',
    fill: '« Celle de la conversation » convient presque toujours. Force l’anglais pour un entretien en anglais où tu prends des notes en français.'
  },
  maxTokens: {
    title: 'Longueur des réponses',
    what: 'La taille maximale de chaque réponse proposée.',
    fill: 'En direct, « Courte » est le bon choix : une phrase à dire et deux ou trois points clés. Plus long = plus lent à lire.'
  },
  model: {
    title: 'Modèle Claude',
    what: 'Le « cerveau » utilisé. Les plus gros sont plus fins mais plus lents et plus chers.',
    fill: 'Haiku pour le direct (réponse en une à deux secondes). Sonnet si les questions sont pointues et que tu peux attendre un peu.'
  },
  numbersInWords: {
    title: 'Nombres en toutes lettres',
    what: 'Les chiffres, dates et heures sont écrits en mots.',
    fill: 'Utile quand tu lis la réponse à voix haute, surtout dans une langue étrangère.',
    example: '« le douze mars deux mille vingt-quatre » au lieu de « 12/03/2024 »'
  },
  autoEarly: {
    title: 'Réponse anticipée',
    what: 'En mode « Tout seul », Claude commence dès que la question est reconnue, sans attendre la validation complète de la phrase.',
    fill: 'Gagne environ une demi-seconde. Désactive si les réponses partent sur des phrases incomplètes.'
  },
  autoOnlyQuestions: {
    title: 'Seulement les questions',
    what: "En mode « Tout seul », l'assistant ne répond que quand une question est posée.",
    fill: 'Laisse activé pour économiser des appels et éviter les réponses inutiles.'
  },
  bufferMinutes: {
    title: 'Conversation retenue',
    what: 'Combien de minutes de la conversation récente sont envoyées à Claude avec chaque demande.',
    fill: 'Huit minutes suffisent en général. Plus = meilleur contexte mais demandes plus lentes et plus chères.'
  },
  autoDebounceMs: {
    title: 'Attente avant réponse',
    what: 'Petit délai après la fin d’une phrase avant de lancer la réponse automatique.',
    fill: 'Laisse autour de 150 ms. Augmente si l’assistant répond pendant que la personne n’a pas fini.'
  },
  autoMinGapMs: {
    title: 'Écart entre réponses',
    what: 'Temps minimum entre deux réponses automatiques.',
    fill: 'Évite une rafale de réponses quand plusieurs phrases s’enchaînent. 1 500 ms est un bon point de départ.'
  },
  systemPrompt: {
    title: 'Instructions détaillées',
    what: "Le texte qui dit à Claude comment se comporter. Le « type de situation » le remplit pour toi.",
    fill: "Ne le modifie que si tu veux un style précis. Écris des consignes simples, à l'impératif.",
    example: 'Réponds en une phrase que je peux dire telle quelle, puis au plus trois points clés. Vouvoie l’interlocuteur.'
  },

  // ----- Mon profil -----
  ragEnabled: {
    title: 'Utiliser mon profil',
    what: 'Ton profil et tes documents sont joints à chaque demande pour que les réponses parlent de toi.',
    fill: 'Active-le dès que tu as rempli « Qui je suis ».'
  },
  ragProfile: {
    title: 'Qui je suis',
    what: "Ce que l'assistant doit toujours savoir sur toi pour répondre à ta place.",
    fill: 'Ton prénom, ta formation, ton poste, ton objectif, deux ou trois projets marquants, ta façon de parler. Reste factuel : Claude reprendra ces éléments mot pour mot.',
    example:
      "Je m'appelle Alex, 23 ans, en mastère cybersécurité et en alternance dans une équipe sécurité. Je vise un poste de pentester junior en Île-de-France. Projets : un relais DNS en Go (cache, filtrage), un outil de scan de vulnérabilités web. Je préfère des réponses directes et concrètes.",
    apply: true
  },
  ragDocs: {
    title: 'Documents sur moi',
    what: 'Des fichiers texte plus longs que le profil. Seuls les passages proches de la question sont envoyés.',
    fill: 'Ton CV, une fiche par projet, tes notes de préparation. Exporte d’abord les PDF et Word en texte.',
    example: 'cv.md, projet-dns-relay.txt, reponses-entretien.md'
  },
  ragTopK: {
    title: 'Passages par demande',
    what: 'Combien de passages de tes documents sont joints à chaque demande.',
    fill: 'Quatre est un bon équilibre. Plus = plus de contexte, mais demandes plus longues.'
  },

  // ----- Documents de travail -----
  kbEnabled: {
    title: 'Utiliser mes documents de travail',
    what: "Les bases actives sont consultées à chaque demande : l'assistant retrouve les fichiers et les lignes qui parlent du sujet.",
    fill: 'Laisse activé ; tu peux désactiver une base précise plus bas.'
  },
  kbSelect: {
    title: 'Bases de connaissances',
    what: 'Une base regroupe des documents sur un même sujet : un projet, un cours, un code de loi…',
    fill: 'Une base par sujet, pour que l’assistant ne mélange pas tout. Choisis ici celle à modifier.'
  },
  kbName: {
    title: 'Créer une base',
    what: 'Donne un nom clair, tu le reverras dans les réponses.',
    fill: 'Tape le nom puis clique sur « Créer ». Pour renommer la base choisie, tape le nouveau nom puis « Renommer ».',
    example: 'Projet DNS Relay v3 · Cours de cryptographie · Code du travail'
  },
  kbFiles: {
    title: 'Ajouter des fichiers',
    what: "Les fichiers sont lus et indexés sur ce PC. Le code est découpé par fonction, avec les numéros de ligne.",
    fill: 'Pour un projet de code, ajoute le dossier racine. Réimporter le même dossier ne relit que les fichiers modifiés.',
    example: 'Le dossier « dns-relay » contenant main.go, internal/, README.md'
  },
  kbAbout: {
    title: 'Ton lien avec ces documents',
    what: 'Toujours envoyé avec la base. Indique si tu en es l’auteur et ce que tu dois pouvoir en dire.',
    fill: 'Qui l’a écrit, dans quel cadre, et ce que tu veux pouvoir expliquer.',
    example:
      "C'est mon projet DNS Relay v3, que j'ai écrit seul en Go pendant mon alternance. Il relaie les requêtes DNS avec un cache et un filtrage des domaines. Je dois pouvoir justifier chaque choix technique en entretien.",
    apply: true
  },
  kbNotes: {
    title: 'Faire comprendre le contenu',
    what: "« Résumer les fichiers » fait écrire à Claude une note par fichier : rôle, noms des fonctions, choix. Ces notes permettent de retrouver le bon fichier même si la question n'emploie pas ses mots. « Générer la fiche » en fait une synthèse globale.",
    fill: 'Lance les deux une fois après l’import. Le coût est estimé et affiché avant chaque lancement.'
  },
  kbBrief: {
    title: 'Fiche de synthèse',
    what: 'Résumé de toute la base (architecture, éléments clés, choix et raisons, questions probables), envoyé à chaque demande.',
    fill: 'Relis-la et corrige ce qui est faux, surtout les « pourquoi » : c’est ce que l’assistant répétera.'
  },
  kbAutoSummary: {
    title: 'Résumer à l’import',
    what: 'Les nouveaux fichiers sont résumés automatiquement juste après un import.',
    fill: 'Une confirmation est demandée si l’import est volumineux.'
  },
  kbTopK: {
    title: 'Passages par demande',
    what: 'Nombre maximal de passages de fichiers joints à chaque demande.',
    fill: 'Huit convient pour du code. Baisse si les réponses deviennent lentes.'
  },
  kbBudgetChars: {
    title: 'Taille maximale des passages',
    what: 'Limite le volume de texte envoyé par demande.',
    fill: '12 000 caractères ≈ 3 000 tokens. Plus = plus de contexte, mais plus lent et plus cher.'
  },

  // ----- Fenêtre -----
  hkToggle: {
    title: 'Afficher / masquer',
    what: 'Fait apparaître ou disparaître la fenêtre de réponse, même quand une autre appli est au premier plan.',
    fill: 'Clique dans le champ et appuie sur ta combinaison. Choisis-en une que tes autres applis n’utilisent pas.',
    example: 'Ctrl+Alt+Space'
  },
  hkAsk: {
    title: 'Demander une réponse',
    what: 'Envoie la conversation récente à Claude et affiche la réponse.',
    fill: 'Une combinaison facile à faire d’une main pendant un appel.',
    example: 'Ctrl+Alt+Enter'
  },
  hkClear: {
    title: 'Repartir de zéro',
    what: 'Efface la transcription, les réponses et la mémoire de la conversation en cours.',
    fill: 'À utiliser entre deux appels pour ne pas mélanger les sujets.',
    example: 'Ctrl+Alt+Backspace'
  },
  opacity: {
    title: 'Opacité',
    what: 'Transparence de la fenêtre de réponse.',
    fill: 'Un peu transparente (0,9) pour voir ce qu’il y a derrière sans gêner la lecture.'
  },
  fontSize: {
    title: 'Taille du texte',
    what: 'Taille du texte dans la fenêtre de réponse.',
    fill: 'Assez grande pour lire d’un coup d’œil sans t’approcher de l’écran.'
  },
  showTranscript: {
    title: 'Montrer la transcription',
    what: 'Affiche en petit ce qui vient d’être entendu, sous la réponse.',
    fill: 'Pratique pour vérifier que l’appli entend bien. Désactive pour une fenêtre plus compacte.'
  },
  contentProtection: {
    title: 'Cacher dans les partages d’écran',
    what: 'La fenêtre de réponse reste visible pour toi mais apparaît vide (ou absente) dans Teams, Zoom, OBS ou les captures d’écran.',
    fill: 'Laisse activé si tu partages ton écran. La fenêtre des réglages, elle, reste visible.'
  },
  startHidden: {
    title: 'Démarrer masquée',
    what: "L'appli démarre sans afficher la fenêtre de réponse ; tu l’appelles avec le raccourci.",
  },
  launchAtStartup: {
    title: 'Lancer avec Windows',
    what: "L'appli démarre en même temps que Windows (version installée uniquement)."
  },

  // ----- Transfert -----
  exportPassword: {
    title: 'Mot de passe du fichier',
    what: "Chiffre le fichier d'export (AES-256). Sans le mot de passe, personne ne peut lire ton profil, tes documents ni tes clés.",
    fill: "Un mot de passe que tu retiendras pendant le transfert. Il n'est enregistré nulle part : s'il est perdu, le fichier est illisible.",
    example: 'Une phrase de quatre mots, ex. « portable-oral-mardi-matin »'
  },
  exportKeys: {
    title: 'Inclure les clés API',
    what: "Les clés ElevenLabs et Claude sont ajoutées au fichier, chiffrées avec ton mot de passe. Sur l'autre PC, tu n'auras rien à recoller.",
    fill: 'Active-le seulement avec un mot de passe solide. Sans clés, il suffit de les recoller dans la page Clés API après l’import.'
  },
  importFile: {
    title: 'Importer',
    what: "Remplace les réglages, le profil et les bases de ce PC par ceux du fichier. Les choix de sortie audio sont remis par défaut car ils dépendent de chaque PC.",
    fill: "Choisis le fichier .deskassistant exporté sur l'autre PC. Une copie de sécurité est faite dans le dossier de l'appli (backups) avant de remplacer quoi que ce soit."
  },

  // ----- Mises à jour -----
  updateCard: {
    title: 'Mettre à jour',
    what: "L'appli regarde la dernière version publiée sur GitHub. Si elle est plus récente, tu peux la télécharger puis l'installer en un clic : l'appli se ferme, s'installe et se rouvre toute seule.",
    fill: "L'installeur téléchargé est vérifié avec son empreinte SHA-256 publiée par GitHub ; s'il ne correspond pas, il est supprimé. Tes réglages, clés et bases sont conservés."
  },
  autoUpdateCheck: {
    title: 'Vérification automatique',
    what: 'Une vérification discrète au démarrage puis toutes les six heures. Si une version sort, un point apparaît dans le menu et un bouton dans la fenêtre de réponse.',
    fill: 'Laisse activé. Rien ne s’installe sans que tu cliques.'
  },

  // ----- Diagnostic -----
  diagState: {
    title: 'État de l’écoute',
    what: 'Écoute : l’appli écoute-t-elle ? Capture : le son du PC est-il récupéré ? Transcription : la connexion à ElevenLabs est-elle prête ?',
    fill: 'Tout doit être vert quand tu écoutes. Un message en orange explique le problème et quoi faire.'
  },
  meters: {
    title: 'Niveaux du son',
    what: 'Une barre par sortie audio écoutée. Elle bouge quand du son passe.',
    fill: 'Lance une vidéo : si aucune barre ne bouge, change le « Son à écouter » dans la page Écoute.'
  }
}

/** Ordre de la visite guidée : une page, puis les réglages essentiels de cette page. */
export interface TourStep {
  page: string
  /** Clé de HELP, ou null pour une étape d'introduction sans cible */
  help: string | null
  /** Élément à mettre en lumière (par défaut : le champ [data-help=…]) */
  target?: string
  title?: string
  body?: string
}

export const TOUR: TourStep[] = [
  {
    page: 'accueil',
    help: null,
    target: '#setupSteps',
    title: 'Bienvenue dans la visite',
    body: 'On va passer en revue les réglages qui comptent, page par page. Les réglages avancés restent repliés : les valeurs par défaut conviennent dans la plupart des cas. Tu peux quitter à tout moment avec Échap.'
  },
  { page: 'accueil', help: null, target: '#side', title: 'Les pages', body: "Chaque page regroupe un thème. Un point orange signale ce qu'il reste à faire. Le bouton « ? » à côté d'un réglage rouvre son explication." },
  { page: 'cles', help: 'elevenLabsKey' },
  { page: 'cles', help: 'anthropicKey' },
  { page: 'ecoute', help: 'audioSource' },
  { page: 'ecoute', help: 'sttLanguage' },
  { page: 'ecoute', help: 'vadSilenceSecs' },
  { page: 'reponses', help: 'preset' },
  { page: 'reponses', help: 'sessionContext' },
  { page: 'reponses', help: 'mode' },
  { page: 'reponses', help: 'model' },
  { page: 'moi', help: 'ragProfile' },
  { page: 'moi', help: 'ragDocs' },
  { page: 'pro', help: null, target: '#page-pro .page-head', title: 'Documents de travail', body: "Pour les entretiens techniques ou les sujets pointus : l'assistant consulte tes projets et documents pour citer le bon fichier et la bonne ligne. Trois étapes, dans l'ordre." },
  { page: 'pro', help: 'kbName' },
  { page: 'pro', help: 'kbFiles' },
  { page: 'pro', help: 'kbAbout' },
  { page: 'pro', help: 'kbNotes' },
  { page: 'fenetre', help: 'hkAsk' },
  { page: 'fenetre', help: 'contentProtection' },
  { page: 'transfert', help: 'exportPassword' },
  { page: 'transfert', help: 'importFile' },
  { page: 'maj', help: 'updateCard' },
  { page: 'diag', help: 'meters' },
  {
    page: 'diag',
    help: null,
    target: '#savebar',
    title: 'Enregistrer',
    body: "N'oublie pas d'enregistrer (bouton ou Ctrl+S). La barre indique quand des changements sont en attente. C'est tout : lance une vidéo, regarde les barres bouger, puis essaie le raccourci de réponse."
  }
]
