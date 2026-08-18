# CodeConform-Bench (CCB)

> Un benchmark exécutable de conformité architecturale du code généré par IA.

[English](README.md) · [Français](README.fr.md)

## Vue d’ensemble

CodeConform-Bench (CCB) mesure si des agents de développement IA produisent du code qui respecte une architecture logicielle cible.

Pour chaque tâche, CCB exécute deux fois le même modèle, dans des conditions identiques :

- **Baseline** — le modèle travaille sans Grace.
- **Grace** — le même modèle travaille avec Grace.

Le code produit est évalué par des règles d’architecture exécutables et invisibles au modèle. Une gate fonctionnelle s’exécute d’abord : un code qui ne compile pas ou casse la suite de tests fonctionnels existants est déclaré en échec fonctionnel et ne reçoit pas de score d’architecture.

CCB rend l’effet d’un guidage architectural mesurable, reproductible et réfutable.

## Ce que CCB mesure

CCB publie :

- **Conformité architecturale** — la proportion de règles d’architecture exécutables qui passent, en score brut et pondéré par criticité.
- **Taux d’échec fonctionnel** — les runs qui ne compilent pas ou cassent les tests fonctionnels existants.
- **Delta Grace** — l’écart entre les scores Grace et baseline, pour un même modèle, langage et scénario.
- **Efficience** — tokens, coût, latence et gain de qualité pour 1 000 tokens supplémentaires.
- **Régularité** — la distribution des scores sur plusieurs runs, pas une tentative isolée.

CCB ne prétend pas mesurer toute la qualité du code. Lisibilité, pertinence métier, sécurité et qualité des tests demandent des évaluations complémentaires.

## Protocole

```mermaid
flowchart LR
    T[Repo de tâche figé] --> B[Modèle seul]
    T --> G[Même modèle + Grace]
    B --> F1[Gate fonctionnelle]
    G --> F2[Gate fonctionnelle]
    F1 -->|vert| A1[Règles d'architecture cachées]
    F2 -->|vert| A2[Règles d'architecture cachées]
    A1 --> S1[Score baseline]
    A2 --> S2[Score Grace]
    S1 --> D[Delta mesuré]
    S2 --> D
```

Le protocole est figé et publié avant les runs :

1. Un repo de tâche est provisionné depuis une révision de template épinglée.
2. Les deux conditions reçoivent la même tâche, les mêmes outils, le même budget de tokens et le même budget d’étapes.
3. Le modèle reçoit l’intention architecturale, jamais les assertions exécutables.
4. Chaque condition est répétée au moins cinq fois.
5. L’évaluateur s’exécute hors du workspace de l’agent ; ses règles ne sont pas accessibles au modèle.
6. Les résultats publient médianes, intervalles de confiance, données brutes de chaque run et versions exactes des modèles.

## Architecture proposée du benchmark

L’architecture proposée sépare les workspaces des agents de l’évaluateur privé. La CI/CD fournit un dépôt cible épinglé aux runs baseline et Grace, dans les mêmes conditions. Seuls les runs qui réussissent la gate fonctionnelle reçoivent un score d’architecture.

```mermaid
flowchart LR
    accTitle: Architecture proposée du benchmark CCB
    accDescr {
      La CI/CD clone un dépôt cible à une révision épinglée et crée des workspaces baseline et Grace identiques.
      Les deux workspaces passent par une gate fonctionnelle. Les runs réussis sont évalués en privé et combinés avec les métadonnées de run dans les résultats du benchmark.
    }
    CI[CI/CD CCB] -->|clone| T[Dépôt cible]
    T -->|épingle la révision| B[Workspace baseline]
    T -->|épingle la révision| G[Workspace Grace]
    B -->|exécute| FB[Gate fonctionnelle]
    G -->|exécute| FG[Gate fonctionnelle]
    FB -->|autorise| E[Évaluateur privé]
    FG -->|autorise| E
    E -->|produit| R[Résultats du benchmark]
    M[Versions épinglées et métadonnées de run] -->|identifie| R
```

Équivalent textuel : la CI/CD clone un dépôt cible épinglé pour baseline et Grace. Chaque run doit réussir la gate fonctionnelle avant que l’évaluateur privé séparé produise des résultats d’architecture, identifiés par les versions épinglées et les métadonnées de run.

## Matrice initiale des modèles

CCB compare des niveaux de gamme, et non des équivalences de qualité présumées. Chaque campagne épingle l’identifiant du modèle et consigne sa configuration fournisseur.

| Niveau | Anthropic | OpenAI | Google | Mistral |
| --- | --- | --- | --- | --- |
| Rapide et économique | `anthropic/claude-haiku-4.5` | `openai/gpt-5.6-luna` | `google/gemini-3.1-flash-lite` | `mistralai/mistral-small-2603` |
| Agent de code équilibré | `anthropic/claude-sonnet-5` — élevé | `openai/gpt-5.6-terra` — élevé | `google/gemini-3.7-flash` — élevé | `mistralai/mistral-medium-3-5` — élevé |
| Raisonnement autonome premium | `anthropic/claude-fable-5` — élevé | `openai/gpt-5.6-sol` — élevé | `google/gemini-3.1-pro-preview` — élevé | — |

Gemini 3.1 Pro Preview est inclus volontairement dans le niveau premium. Chaque résultat qui l’utilise doit l’identifier comme une preview et consigner l’identifiant exact du modèle ainsi que la date du run. Aucun modèle Codestral ou Devstral n’est inclus : les spécialistes du code ne sont pas des équivalents de niveau de gamme. Mistral Medium 3.5 doit exécuter son niveau de raisonnement élevé, consigné pour chaque run. Le niveau rapide et économique consigne la configuration de raisonnement disponible chez chaque fournisseur, sans supposer que tous les modèles supportent le niveau élevé.

Sources : [Claude Haiku 4.5](https://openrouter.ai/anthropic/claude-haiku-4.5), [Claude Sonnet 5](https://openrouter.ai/anthropic/claude-sonnet-5), [Claude Fable 5](https://openrouter.ai/anthropic/claude-fable-5), [GPT-5.6 Luna](https://openrouter.ai/openai/gpt-5.6-luna), [GPT-5.6 Terra](https://openrouter.ai/openai/gpt-5.6-terra), [GPT-5.6 Sol](https://openrouter.ai/openai/gpt-5.6-sol), [Gemini 3.1 Flash Lite](https://openrouter.ai/google/gemini-3.1-flash-lite), [Gemini 3.1 Pro Preview](https://openrouter.ai/google/gemini-3.1-pro-preview), [Gemini 3.7 Flash](https://openrouter.ai/google/gemini-3.7-flash), [Mistral Small 4](https://openrouter.ai/mistralai/mistral-small-2603), [Mistral Medium 3.5](https://openrouter.ai/mistralai/mistral-medium-3-5) et [configuration de raisonnement OpenRouter](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

## Règles d’architecture

Chaque adaptateur de langage exprime la même sémantique architecturale avec son outillage natif. Les catégories initiales sont :

- direction autorisée des dépendances entre couches ;
- cycles de dépendances interdits ;
- placement et conventions de nommage des rôles architecturaux ;
- accès à l’infrastructure interdit hors des frontières d’infrastructure ;
- score pondéré selon les violations bloquantes, majeures ou mineures.

La matrice prévue couvre Java/Kotlin, C#/.NET, TypeScript, Python et Go.

## Reproductibilité et anti-contamination

CCB traite l’isolation de l’évaluation comme une propriété fondamentale :

- les règles d’architecture sont exécutées depuis un dépôt privé distinct ou un artefact CI ;
- le workspace de l’agent contient le code et les tests fonctionnels, jamais la suite d’évaluation ;
- les noms des jobs et fichiers d’évaluation sont neutres ;
- les traces d’exécution sont conservées pour vérifier que les règles cachées n’ont pas été lues ;
- chaque release du benchmark épingle les templates, prompts, identifiants de modèles, version du harness et règles d’évaluation.

## État du projet

CCB définit et valide actuellement son premier protocole public. Le dépôt publiera progressivement le harness exécutable, les adaptateurs de langage, les templates de tâches, la spécification de score et les résultats agrégés.

### Première cible de benchmark documentée

CCB utilisera d’abord `ccb-ohmyform` comme cible de benchmark. La CI/CD clonera ce dépôt pour exécuter les runs.

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

