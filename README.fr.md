# CodeConform-Bench (CCB)

> Un benchmark exécutable de correction fonctionnelle et de qualité du code généré par IA.

[English](README.md) · [Français](README.fr.md)

## Vue d’ensemble

CodeConform-Bench (CCB) mesure si des agents de développement IA produisent du code fonctionnel, maintenable et conforme à une architecture logicielle cible.

Pour chaque tâche, CCB exécute deux fois le même modèle, dans des conditions identiques :

- **Baseline** — le modèle travaille sans Grace.
- **Grace** — le même modèle travaille avec Grace.

Le benchmark applique d’abord une gate fonctionnelle immuable, extérieure au checkout candidat. Les échecs fonctionnels ou de l’agent reçoivent un score de qualité nul. Les candidats fonctionnels sont ensuite évalués par des règles déterministes isolées couvrant architecture, maintenabilité, clarté, tests et robustesse.

CCB rend la qualité du code de chaque modèle et l’effet de Grace mesurables, reproductibles et réfutables.

## Ce que CCB mesure

CCB publie :

- **Functional pass@1** — la proportion de premières tentatives valides qui préservent le comportement épinglé.
- **Quality-qualified pass@1** — la proportion qui franchit aussi les seuils globaux et par dimension du rule pack versionné.
- **Code Quality Score** — la moyenne end-to-end de l’architecture, la maintenabilité, la clarté, les tests et la robustesse ; les échecs fonctionnels ou de l’agent valent zéro.
- **Delta Grace** — l’écart apparié entre Grace et baseline pour le même modèle, la même tâche et la même tentative.
- **Efficience** — tokens, coût, latence et gain de qualité pour 1 000 tokens supplémentaires, publiés séparément de la capacité.
- **Fiabilité** — les échecs candidats restent des résultats scorés ; les erreurs d’infrastructure fournisseur, harness ou évaluateur sont exclues et publiées explicitement.

La tranche OhMyForm actuelle reste une étude de cas sur une seule tâche. Généraliser entre modèles demande une suite versionnée plus large avec un poids égal par tâche.

## Protocole

```mermaid
flowchart LR
    T[Repo de tâche figé] --> B[Modèle seul]
    T --> G[Même modèle + Grace]
    B --> F1[Gate fonctionnelle]
    G --> F2[Gate fonctionnelle]
    F1 -->|vert| A1[Évaluateur qualité isolé]
    F2 -->|vert| A2[Évaluateur qualité isolé]
    A1 --> S1[Score qualité baseline]
    A2 --> S2[Score qualité Grace]
    S1 --> D[Delta mesuré]
    S2 --> D
```

Le protocole est figé et publié avant les runs :

1. Un repo de tâche est provisionné depuis une révision de template épinglée.
2. Les deux conditions reçoivent la même tâche, les mêmes outils, le même budget de tokens et le même budget d’étapes.
3. Le modèle reçoit l’intention fonctionnelle et de qualité du code, jamais les assertions exécutables.
4. Chaque condition est répétée trois fois et agrégée comme tentatives pass@1.
5. L’évaluateur s’exécute hors du workspace de l’agent ; ses règles ne sont pas accessibles au modèle.
6. Les résultats publient moyennes, intervalles appariés, scores par dimension, données brutes et versions exactes des modèles.

## Architecture implémentée du benchmark

Le harness Node de confiance appelle directement OpenRouter et expose quatre outils : lister, lire et écrire dans le candidat, puis lancer une commande de validation nommée. Les commandes s’exécutent sur un montage candidat en lecture seule dans Docker, sans réseau, credentials, socket Docker ni montage de l’évaluateur. Le probe fonctionnel final n’est monté qu’après la fin de l’agent ; ses assertions restent dans le processus hôte. L’évaluateur n’est introduit qu’après la réussite de cette gate.

```mermaid
flowchart LR
    accTitle: Architecture implémentée du benchmark CCB
    accDescr {
      Le harness de confiance crée des workspaces candidats appariés et appelle le même modèle avec et sans Grace.
      Les commandes candidat s’exécutent dans un conteneur sans réseau. Les candidats fonctionnels sont ensuite notés par un évaluateur séparé.
    }
    M[Manifest de campagne immuable] --> H[Harness SDK de confiance]
    T[Commit et tree cibles épinglés] --> H
    H --> B[Workspace baseline]
    H --> G[Workspace Grace]
    B --> X[Commandes Docker autorisées]
    G --> X
    X --> F[Gate fonctionnelle]
    F -->|vert| E[Évaluateur séparé]
    F -->|rouge| R[Résultat scoré à qualité nulle]
    E --> R[Agrégat et provenance]
```

L’ordre baseline/Grace alterne entre les paires. Les échecs fonctionnels ou de l’agent valent zéro ; les erreurs d’infrastructure fournisseur, harness ou évaluateur sont exclues des dénominateurs concernés et publiées explicitement. Les deltas Grace utilisent toutes les paires valides des deux côtés.

## Matrice initiale des modèles

CCB compare des niveaux de gamme, et non des équivalences de qualité présumées. Chaque campagne épingle l’identifiant du modèle et consigne sa configuration fournisseur.

| Niveau | Anthropic | OpenAI | Google | Mistral |
| --- | --- | --- | --- | --- |
| Rapide et économique | `anthropic/claude-haiku-4.5` | `openai/gpt-5.6-luna` | `google/gemini-3.1-flash-lite` | `mistralai/mistral-small-2603` |
| Agent de code équilibré | `anthropic/claude-sonnet-5` — élevé | `openai/gpt-5.6-terra` — élevé | `google/gemini-3.7-flash` — élevé | `mistralai/mistral-medium-3-5` — élevé |
| Raisonnement autonome premium | `anthropic/claude-fable-5` — élevé | `openai/gpt-5.6-sol` — élevé | `google/gemini-3.1-pro-preview` — élevé | — |

Gemini 3.1 Pro Preview est inclus volontairement dans le niveau premium. Chaque résultat qui l’utilise doit l’identifier comme une preview et consigner l’identifiant exact du modèle ainsi que la date du run. Aucun modèle Codestral ou Devstral n’est inclus : les spécialistes du code ne sont pas des équivalents de niveau de gamme. Mistral Medium 3.5 doit exécuter son niveau de raisonnement élevé, consigné pour chaque run. Le niveau rapide et économique consigne la configuration de raisonnement disponible chez chaque fournisseur, sans supposer que tous les modèles supportent le niveau élevé.

Sources : [Claude Haiku 4.5](https://openrouter.ai/anthropic/claude-haiku-4.5), [Claude Sonnet 5](https://openrouter.ai/anthropic/claude-sonnet-5), [Claude Fable 5](https://openrouter.ai/anthropic/claude-fable-5), [GPT-5.6 Luna](https://openrouter.ai/openai/gpt-5.6-luna), [GPT-5.6 Terra](https://openrouter.ai/openai/gpt-5.6-terra), [GPT-5.6 Sol](https://openrouter.ai/openai/gpt-5.6-sol), [Gemini 3.1 Flash Lite](https://openrouter.ai/google/gemini-3.1-flash-lite), [Gemini 3.1 Pro Preview](https://openrouter.ai/google/gemini-3.1-pro-preview), [Gemini 3.7 Flash](https://openrouter.ai/google/gemini-3.7-flash), [Mistral Small 4](https://openrouter.ai/mistralai/mistral-small-2603), [Mistral Medium 3.5](https://openrouter.ai/mistralai/mistral-medium-3-5) et [configuration de raisonnement OpenRouter](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

## Grille de qualité du code

L’évaluateur TypeScript publie cinq dimensions normalisées et pondérées dans le rule pack : architecture (30 %), maintenabilité (25 %), clarté et discipline de typage (20 %), tests (15 %) et robustesse (10 %). Le rule pack OhMyForm v2 vérifie par analyse des dépendances et de l’AST TypeScript :

- direction des dépendances, rôles requis et cycles interdits ;
- bornes de taille des fichiers et fonctions, nombre de paramètres et complexité du contrôle ;
- absence de `any` explicite, suppressions de diagnostics et assertions non-nulles dans la tranche évaluée ;
- tests ciblés de succès et d’échec, sans cas ignoré ou focalisé ;
- absence de `catch` vide, d’exécution dynamique et d’import permettant de lancer des processus.

Un candidat n’est qualifié que si son score pondéré atteint 70 % et si chaque dimension atteint son minimum publié. Les adaptateurs d’autres langages peuvent employer leurs outils natifs, mais doivent conserver les mêmes dimensions et le même contrat de score.

La matrice prévue couvre Java/Kotlin, C#/.NET, TypeScript, Python et Go.

## Reproductibilité et anti-contamination

CCB traite l’isolation de l’évaluation comme une propriété fondamentale :

- l’évaluateur et le rule pack versionné restent hors du checkout candidat ;
- le modèle ne reçoit ni shell, ni outil web/search/fetch, ni chemin d’évaluateur, ni credential ;
- les commandes candidat s’exécutent dans Docker avec `--network none`, un workspace et des dépendances vérifiées par digest en lecture seule, des ressources bornées, un seul appel de validation et aucun socket Docker ;
- le commit/tree cible et le digest de l’export matérialisé, l’endpoint MCP Grace, les digests des montages de dépendances/probe, l’image du conteneur, le runner d’évaluation, le rule pack, la politique fournisseur, les prompts, les artefacts candidats et les traces sont épinglés ou hashés ;
- l’évaluateur ne renvoie que le statut, les compteurs et les scores agrégés ; aucun diagnostic détaillé n’est envoyé au modèle.

Le benchmark vérifie un comportement observable, pas la résistance à un programme volontairement conscient du test. L’agent ne reçoit jamais le probe final ni ses assertions ; un code qui détecte intentionnellement l’environnement de validation pour le traiter à part sort du modèle de menace expérimental.

## État et vérification

La première tranche v2 est `campaigns/ohmyform-v2.json` : trois tentatives pass@1 appariées sur la tâche OhMyForm submission-start épinglée. Le harness public, le parseur strict de manifest v2, la boucle d’outils OpenRouter, l’exécuteur Docker, la gate fonctionnelle, l’évaluateur multidimensionnel, l’agrégation appariée qui tient compte des échecs et les preuves de provenance sont implémentés.

```sh
npm ci --ignore-scripts
npm test
```

Les agents de code locaux lisent `.mcp.json` et effectuent l’OAuth Grace lors de leur première connexion. Les campagnes payantes s’exécutent via `.github/workflows/benchmarks.yml` ; GitHub Actions étant non interactif, elles utilisent à la place les secrets de repository `OPENROUTER_API_KEY` et `GRACE_MCP_TOKEN`. Seuls les runs Grace se connectent au MCP du SaaS Grace configuré ; les runs baseline ne reçoivent ni ses instructions ni ses outils. Les contrôles du harness et chaque benchmark apparaissent comme des jobs séparés dans le graphe GitHub Actions. Chaque benchmark publie sa consommation de tokens, son coût OpenRouter, ses résultats appariés et ses erreurs dans le Job Summary, puis attache `report.md`, `aggregate.json` et les preuves de provenance dans un artifact conservé 30 jours. Les workspaces candidats et les traces modèle brutes ne sont jamais publiés. Le guide `docs/ia/benchmark-bootstrap/user-guide.md` donne la procédure exacte.

### Première cible de benchmark

Le checkout OhMyForm audité et la campagne sont épinglés dans `campaigns/ohmyform-v2.json`.

#### Architecture actuelle et état d’OhMyForm

Le checkout audité (`c099827`) est organisé en trois tiers techniques côté backend, et non en clean/hexagonal architecture. Les schémas ci-dessous décrivent les dépendances de code, pas la topologie de déploiement.

##### Backend — architecture de code actuelle en trois tiers

```mermaid
flowchart LR
    subgraph presentation[Présentation — GraphQL]
        resolver[resolver/\nqueries, mutations, field resolvers]
        dto[dto/\ninputs et modèles GraphQL]
        boundary[guard/, pipe/, decorator/\nauth, rôles, lookup ID]
    end
    subgraph application[Services applicatifs]
        formService[service/form/\ncréation, mise à jour, statistiques]
        submissionService[service/submission/\ndémarrage, réponse, finalisation]
        accountService[service/auth/, user/, profile/]
    end
    subgraph data[Données et persistance]
        entity[entity/\nentités TypeORM et valeurs embedded]
        repository[Repositories TypeORM]
        migrations[migrations/\nSQLite, PostgreSQL, MariaDB]
    end
    resolver -->|binds| dto
    boundary -->|protège et résout les arguments| resolver
    resolver -->|invoque| formService
    resolver -->|invoque| submissionService
    resolver -->|invoque| accountService
    formService -->|modifie| entity
    submissionService -->|modifie| entity
    accountService -->|modifie| entity
    formService --> repository
    submissionService --> repository
    accountService --> repository
    repository -->|mappe| entity
```

##### Frontend — architecture de code actuelle

```mermaid
flowchart LR
    subgraph routes[Routes et écrans]
        pages[pages/\nformulaires publics, admin, login, register]
        authBoundary[with.auth.tsx\naccès aux routes]
        structure[structure.tsx, sidemenu.tsx\nshell d’écran]
    end
    subgraph features[UI par fonctionnalité]
        formAdmin[components/form/admin/\nbuilder, logique, design, hooks]
        formRunner[components/form/layouts/\nparcours répondant card et slider]
        fieldTypes[components/form/types/\néditeurs et inputs de champs]
        submissionHook[use.submission.ts\ndémarrage, sauvegarde, finalisation]
    end
    subgraph state[Données et état]
        graphql[graphql/\nqueries, mutations, fragments]
        apollo[Client Apollo\ncache et header auth]
        browserAuth[localStorage\naccess, refresh, redirect]
    end
    shared[UI partagée\nstyled/, i18n, helpers]
    pages --> authBoundary
    pages --> structure
    pages --> formAdmin
    pages --> formRunner
    formAdmin --> fieldTypes
    formRunner --> fieldTypes
    formRunner --> submissionHook
    pages --> graphql
    submissionHook --> graphql
    authBoundary --> graphql
    graphql --> apollo
    authBoundary --> browserAuth
    apollo --> browserAuth
    pages --> shared
    formAdmin --> shared
    formRunner --> shared
```

##### Écarts constatés avec une clean architecture

**Backend**

- Il n’existe pas de couche domaine indépendante : les classes de `entity/` sont des modèles de persistance TypeORM, avec chargement des relations et cascades (`api/src/entity/form.entity.ts`).
- Les services applicatifs dépendent directement des inputs GraphQL, des entités TypeORM et de `Repository<T>`, au lieu de commandes applicatives et de ports de repository possédés par l’application (`api/src/service/form/form.update.service.ts`).
- Les resolvers GraphQL mélangent transport, autorisation, décodage des IDs, mise à jour du cache, chargement des données et orchestration de cas d’usage (`api/src/resolver/form/form.update.mutation.ts`).
- La mise à jour d’un formulaire modifie champs, options, règles conditionnelles, hooks, design, notifications et pages dans une seule opération technique. L’agrégat métier n’a pas de frontière d’invariants isolée (`api/src/service/form/form.update.service.ts`).
- Les effets email et webhook passent par des services concrets ; aucun port applicatif n’isole ces intégrations techniques.
- Aucun test applicatif n’a été trouvé dans le checkout audité : il n’existe donc pas de filet de caractérisation pour extraire les couches.

**Frontend**

- Les routes et composants d’écran consomment directement queries, mutations et fragments GraphQL ; la présentation dépend du contrat de transport (`ui/pages/admin/forms/[id]/index.tsx`).
- Il n’existe pas de couche domaine/applicative frontend indépendante d’Apollo et des payloads GraphQL ; les composants d’édition manipulent les fragments GraphQL comme modèle de travail.
- `use.submission.ts` mélange état UI, génération de token côté client, détection du device navigateur, appels de mutations GraphQL et sérialisation des valeurs.
- `with.auth.tsx` mélange politique d’accès, lookup GraphQL de l’utilisateur, stockage navigateur, UI de chargement et redirections de navigation.
- L’état d’authentification a des mécanismes qui se chevauchent : Apollo lit `localStorage`, tandis qu’un slice Redux `store/auth/` non utilisé reste dans le code.
- Le renderer de formulaire, les éditeurs de champs et l’éditeur de logique conditionnelle répartissent les préoccupations de feature entre routes, hooks et composants, plutôt que de les composer via une frontière applicative stable.

Le produit couvre l’authentification et l’administration, l’édition et la publication de formulaires, onze types de champs déclarés par l’API, la logique conditionnelle, les soumissions progressives, deux layouts répondant, l’internationalisation, les statistiques, les exports, les emails et les webhooks. Les principaux risques de refacto backend sont le gros agrégat `Form` couplé à TypeORM, un flux unique de mise à jour qui réécrit champs/options/logique/hooks/design/notifications/pages, trois dialectes SGBD et l’absence de suite de tests applicatifs dans le checkout audité.


## Contribuer

Les contributions sont bienvenues, en particulier pour :

- les adaptateurs de règles d’architecture natifs aux langages supportés ;
- les tests de mutation prouvant qu’une règle détecte des violations connues ;
- les solutions de référence validant le pouvoir discriminant du score ;
- les templates de tâches et améliorations de reproductibilité ;
- la revue du protocole et l’analyse statistique.

Ouvre une issue avant de proposer une évolution substantielle du protocole ou du score. La comparabilité du benchmark repose sur des règles versionnées et revues.

## Nom

**CCB** signifie **CodeConform-Bench**.

