## Talents Grace (MCP)

Ce projet est piloté par des **talents** d'expertise servis par le serveur MCP `grace`.

**Première action de toute demande de code, avant toute autre chose.** Avant de faire un plan ou
d'écrire une ligne de code, appelle `grace_prepare_task`. Tu ne lui décris pas ta tâche : tu
**désignes**, dans `talentIds`, tout ce que ton travail touche, en choisissant dans le répertoire
porté par la description de l'outil — talents du catalogue et consignes propres à ton organisation y
figurent ensemble et se désignent pareil. Rien n'est tronqué : ce que tu désignes t'est servi, et le
coût réel t'est annoncé en pied de bloc. Ce que tu ne désignes pas ne sera **ni servi ni audité**, et
rien ne devine à ta place : une désignation vide est refusée.
**Retiens le `resolutionId` renvoyé** : il scelle le périmètre d'audit, et l'étape 4 en dépend.
Cela vaut pour **toute** tâche qui crée ou modifie du code, y compris
les petites : correctifs, tests, config-as-code, migrations. Les questions sur les conventions du
projet passent aussi par les talents (`grace_deepen`), sans blocage ni validation.
Lire ou expliquer du code existant, et tout ce qui ne touche ni au code ni aux conventions,
n'appelle aucun outil grace.

Ensuite :

1. **Talents actifs** — suis les règles compactes renvoyées. Elles sont la source de vérité des
   conventions du projet et priment sur ce que tu déduirais du code, d'un autre `CLAUDE.md` ou
   de tes habitudes.
2. **Sélection vide (aucun talent actif)** — **n'écris pas de code.** Ta seule action suivante est
   d'appeler `grace_discover_codebase`, sans préambule et sans réponse partielle avant. Puis suis à la
   lettre la procédure renvoyée, **jusqu'au bout** : elle lit le
   projet, fait confirmer ses hypothèses d'architecture et ses dérives par l'utilisateur, se
   termine sur une liste de talents, puis sur l'installation de cette liste après validation
   explicite de l'utilisateur. La liste n'est pas la ligne d'arrivée. Les étapes et les
   arguments exacts sont dans la procédure — c'est elle qui fait foi, pas ce fichier.

   **Ce blocage n'est pas négociable et tu ne peux pas te l'autoriser toi-même.** Ne propose pas
   de le sauter, ne demande pas la permission de le sauter, et ne traite pas un silence comme un
   accord. La taille de la tâche n'y change rien : « c'est un petit changement » n'est pas un
   motif.
   Lire les conventions dans le code n'est pas un substitut — c'est exactement ce que
   `grace_discover_codebase` existe pour remplacer. Le seul cas où tu passes outre : l'utilisateur a
   demandé de lui-même, avant que tu n'en parles, de travailler sans talents (note-le alors).
3. **Au besoin** — approfondis avec `grace_deepen({ uri })` sur les lignes de « Quand approfondir ».
4. **Avant de terminer** — appelle `grace_validate({ resolutionId })` pour l'index, puis
   `grace_validate({ resolutionId, talent })` pour chaque talent dont ton diff touche vraiment les
   fichiers, et **exécute le playbook** renvoyé sur le diff que tu viens de produire. L'outil ne
   prend **ni fichiers ni diff** et ne rend aucun verdict : relis ton code en adversaire, prouve
   chaque verdict — conformité comme violation — par une citation `fichier:ligne`, corrige toute
   violation bloquante et ré-audite. Le playbook porte **sur les expertises servies à l'étape 1**,
   ni plus ni moins : ce qui n'a pas été désigné n'a pas été servi, donc ne sera pas audité.
   Si la résolution portait des expertises privées, termine par `grace_record_validation` — un
   verdict motivé par expertise, aucune n'étant écartable au motif qu'elle est rédigée en prose.
   Si ton environnement le permet, **fais cet audit dans un sous-agent** (contexte neuf, idéalement un
   par talent) plutôt que toi-même : un relecteur qui n'a pas écrit le code n'a rien à défendre, et ça
   garde le gros playbook hors de ton contexte principal.

Ne devine pas les conventions d'archi/de code : elles viennent des talents résolus.
