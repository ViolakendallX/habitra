# HABITRA — Product Requirements Document
## Autonomous Accountability That Remembers
*Product:* Habitra  
*Type:* Autonomous accountability and habit system  
*Status:* MVP / Hackathon Build
---
# 1. Product Vision
Habitra is an autonomous accountability system that tracks user behavior, remembers meaningful behavioral patterns through Sibyl Memory, learns from previous outcomes, creates realistic commitments, and keeps users accountable through a web app and Telegram.
Habitra is not just a habit tracker.
It observes behavior, understands patterns, remembers important context, recommends better actions, creates challenges with user approval, and learns from the outcome.
## Core Loop
*Track → Remember → Understand → Recommend → Commit → Reward → Learn*
---
# 2. Core MVP
The MVP must allow a user to:
1. Create an account.
2. Create habits.
3. Record completed and missed habits.
4. View their behavioral analytics.
5. Interact with an autonomous accountability agent.
6. Allow the agent to remember meaningful information through Sibyl Memory.
7. Receive personalized recommendations.
8. Accept personalized challenges.
9. Connect a wallet.
10. Fund/participate in challenges on Base Sepolia.
11. Earn BEES rewards for successful challenges.
12. Receive autonomous accountability messages through Telegram.
The system must be built incrementally and tested after every major feature.
---
# 3. System Architecture
```text
                         HABITRA
                            │
              ┌─────────────┴─────────────┐
              │                           │
       React + Vite                  Telegram
        Web App                       Python
              │                           │
              └─────────────┬─────────────┘
                            │
                       Node.js API
                            │
        ┌───────────┬───────┼────────┬──────────┐
        │           │       │        │          │
    PostgreSQL    Agent   Sibyl    Blockchain  Auth
                        Memory        │
                                      │
                                 Base Sepolia
                                  │        │
                              BEES Token  Challenge

⸻

4. Frontend

Technology

* React
* Vite
* TypeScript

Pages

The frontend will eventually contain:

/login
/register
/dashboard
/habits
/challenges
/agent
/settings

Dashboard

The dashboard should display:

* Consistency score
* Current streak
* Today’s habits
* Completed habits
* Missed habits
* Active challenge
* BEES balance
* Agent insights

The frontend communicates with the Node.js backend through API requests.

⸻

5. Backend

Technology

* Node.js
* Express
* TypeScript
* Prisma
* PostgreSQL
* Zod
* bcrypt
* JWT
* viem

The backend is responsible for:

* Authentication
* Users
* Habits
* Habit completions
* Analytics
* Agent operations
* Sibyl Memory communication
* Challenges
* Wallet operations
* Blockchain interaction
* Telegram communication
* Background jobs

⸻

6. Authentication

Registration

Endpoint:

POST /api/auth/register

User provides:

* Name
* Email
* Password

Flow:

Validate input
      ↓
Check existing email
      ↓
Hash password
      ↓
Create user
      ↓
Create session

Login

POST /api/auth/login

Logout

POST /api/auth/logout

Authentication must work before protected application features are implemented.

⸻

7. Habit System

Users must be able to:

* Create habits
* Edit habits
* Pause habits
* Resume habits
* Delete habits
* View habit history

Habit fields

id
userId
name
description
frequency
target
preferredTime
status
createdAt
updatedAt

⸻

8. Habit Completion

The flow is:

React
  ↓
Node API
  ↓
PostgreSQL

Each completion record contains:

habitId
userId
date
status
missReason
createdAt

Statuses:

COMPLETED
MISSED

Only one completion record should exist for a habit per day.

⸻

9. Analytics Engine

Analytics must be calculated deterministically by the backend.

The LLM must NOT calculate core numerical analytics.

The backend should calculate:

* Completion percentage
* Current streak
* Best streak
* Weekly performance
* Monthly performance
* Miss frequency
* Most consistent habit
* Least consistent habit
* Common miss reasons
* Best day
* Worst day
* Best time
* Worst time

Example:

Workout: 48%
Reading: 91%
Morning consistency: 87%
Evening consistency: 51%

⸻

10. Consistency Score

Habitra should calculate a deterministic consistency score.

Example:

Consistency Score: 82/100

The score should consider factors such as:

* Completion rate
* Streak consistency
* Frequency consistency
* Repeated misses

The exact formula must be documented in the backend.

⸻

11. Autonomous Accountability Agent

The agent is the main intelligence of Habitra.

The Node.js backend runs the agent.

The agent should have access to tools such as:

get_user_habits
get_habit_history
get_user_analytics
search_memory
save_memory
get_active_challenges
create_challenge_proposal
get_challenge_progress
get_reward_status
prepare_challenge_funding
prepare_reward_claim

The agent should reason from real user data instead of giving generic habit advice.

⸻

12. Agent Decision Process

User behavior
      ↓
Habit history
      ↓
Analytics
      ↓
Sibyl Memory
      ↓
Agent reasoning
      ↓
Recommendation
      ↓
Possible challenge
      ↓
User confirmation

The agent must use the user’s actual behavioral history.

Example:

Workout completion: 48%
Morning completion: 87%
Evening completion: 51%

The agent could recommend moving workouts to the morning.

⸻

13. Sibyl Memory

Sibyl Memory is a critical component of Habitra.

Memory must be load-bearing.

It should affect future agent decisions.

Habitra should save meaningful information such as:

* User preferences
* Behavioral patterns
* Reasons for failure
* Successful strategies
* Important user statements
* Lessons from previous challenges
* Relevant behavioral context

Example:

User says:

“I always miss my workout at night because I’m tired after work.”

Habitra saves this as meaningful memory.

Later, in a fresh session:

User asks:

“When should I schedule my workout?”

The agent searches memory and recommends mornings because of the previously remembered context.

This demonstrates that the agent actually remembers the user.

Important Memory Requirement

A fresh session must be able to retrieve previously saved meaningful context.

Official references:

* Sibyl Memory Docs: https://docs.sibyllabs.org/
* Sibyl Memory GitHub: https://github.com/Sibyl-Labs/Sibyl-Memory

⸻

14. PostgreSQL vs Sibyl Memory

PostgreSQL and Sibyl Memory serve different purposes.

PostgreSQL stores facts

Examples:

Users
Habits
Completions
Challenges
Wallets
Transactions

Sibyl stores meaningful memories

Examples:

Preferences
Behavioral patterns
Reasons for failure
Successful strategies
Important user statements
Lessons from challenges

Do not treat Sibyl as a replacement for PostgreSQL.

⸻

15. Agent Recommendations

The agent should analyze actual behavioral data.

Example:

Workout: 48%
Reading: 91%
Morning: 87%
Evening: 51%

The agent may recommend:

Move your workout to the morning.
Your morning consistency is significantly stronger than your evening consistency.

The recommendation should be based on analytics and memory.

⸻

16. Challenge System

The agent can propose personalized challenges.

Example:

7-Day Workout Challenge
Target:
Complete workout 6 out of 7 days.
Reward:
50 BEES

The user must decide whether to accept the challenge.

The agent must never create a financial commitment without user confirmation.

⸻

17. Challenge Lifecycle

DRAFT
  ↓
User accepts
  ↓
LOCKED
  ↓
ACTIVE
  ↓
COMPLETED
  ↓
REWARD_CLAIMABLE
  ↓
CLAIMED

Failure path:

ACTIVE → FAILED

⸻

18. Challenge Database

Challenge fields:

id
userId
habitId
name
description
startDate
endDate
target
frequency
allowedMisses
rewardAmount
rewardToken
status
createdAt
updatedAt

⸻

19. Base Sepolia

Base Sepolia will be used for the blockchain component.

Blockchain functionality is responsible for:

* Challenge funding
* Challenge commitment
* Reward availability
* Reward claiming

Habit completion remains primarily off-chain in PostgreSQL.

Individual daily habit completions do not need to be stored on-chain.

Official reference:

https://docs.base.org/

⸻

20. BEES Token

Habitra will use a demo/test token called BEES.

Smart contract:

BeesToken.sol

BEES is deployed on Base Sepolia.

Example:

Complete challenge
      ↓
50 BEES reward
      ↓
Reward becomes claimable
      ↓
User claims
      ↓
BEES sent to wallet

Official reference:

https://docs.openzeppelin.com/contracts/

⸻

21. Challenge Rewards Contract

Smart contract:

ChallengeRewards.sol

Expected flow:

User accepts challenge
      ↓
User signs funding transaction
      ↓
Challenge becomes active
      ↓
Habitra tracks progress off-chain
      ↓
Challenge succeeds
      ↓
Reward becomes claimable
      ↓
User signs claim
      ↓
BEES received

⸻

22. Wallet

The React frontend will allow users to connect their wallet.

Use:

viem

The application must never store:

* Private keys
* Seed phrases
* Wallet passwords

The user signs blockchain transactions through their wallet.

⸻

23. Demo Chain Mode

Development should support:

DEMO_CHAIN_MODE=true

In demo mode:

Challenge
   ↓
Simulated funding
   ↓
Simulated completion
   ↓
Simulated reward

When ready for real blockchain interaction:

DEMO_CHAIN_MODE=false

The application then uses the deployed Base Sepolia contracts.

⸻

24. Telegram Bot

Telegram is the second interface for Habitra.

Technology:

* Python
* FastAPI
* python-telegram-bot

Architecture:

Telegram
   ↓
Python Bot
   ↓
Node.js API
   ↓
Habitra

Official reference:

https://core.telegram.org/bots/api

⸻

25. Telegram Commands

The bot should support:

/start
/status
/habits
/complete
/miss
/challenge
/progress

Example /status:

Current streak: 5 days
Consistency: 82/100
Today's habits:
✓ Reading
✗ Workout
Challenge:
Day 4 of 7

⸻

26. Telegram Account Linking

Do not rely on Telegram usernames.

Flow:

Habitra generates temporary linking token
             ↓
User opens Telegram
             ↓
/start TOKEN
             ↓
Node verifies token
             ↓
Telegram account linked

⸻

27. Autonomous Telegram Accountability

The background system should periodically evaluate user behavior.

Flow:

Background job
      ↓
Check behavior
      ↓
Agent checks history
      ↓
Search Sibyl Memory
      ↓
Agent decides whether intervention is useful
      ↓
Generate accountability message
      ↓
Python Telegram bot sends message

Example:

You haven't logged your workout yet today.
You've missed the last two Tuesday sessions.
Want to get it done now?

The agent should avoid unnecessary messages.

⸻

28. Database

Technology:

PostgreSQL
Prisma

Initial tables:

users
habits
habit_completions
challenges
challenge_progress
telegram_accounts
wallets
transactions

⸻

29. API Structure

The backend should eventually contain:

/api/auth
/api/users
/api/habits
/api/analytics
/api/agent
/api/memory
/api/challenges
/api/wallet
/api/blockchain
/api/telegram

Protected endpoints must require authentication where appropriate.

⸻

30. Security

Never store:

Private keys
Seed phrases
Wallet passwords

Environment variables should contain secrets and configuration such as:

DATABASE_URL
JWT_SECRET
LLM_API_KEY
TELEGRAM_BOT_TOKEN
BASE_RPC_URL
BASE_CHAIN_ID
BEES_TOKEN_ADDRESS
CHALLENGE_CONTRACT_ADDRESS
SIBYL_...

Security requirements:

* Validate API input
* Authenticate protected routes
* Rate-limit sensitive endpoints
* Verify Telegram requests
* Do not expose secrets to React
* Never commit .env files
* Use secure password hashing
* Validate blockchain inputs

⸻

31. Background Jobs

Node.js should periodically check:

* Incomplete habits
* Missed habits
* Active challenges
* Challenge progress
* Accountability opportunities

The agent decides whether an intervention is useful.

⸻

32. Testing

Testing is mandatory.

Every major feature must be tested before moving forward.

Backend

Test:

* Registration
* Login
* Logout
* Habit creation
* Habit completion
* Habit misses
* Analytics
* Streaks
* Challenges
* Agent tools
* Memory
* API authorization

React

Test:

* Registration
* Login
* Dashboard
* Create habit
* Complete habit
* Challenge
* Wallet connection

Telegram

Test:

/start
/status
/habits
/complete
/miss
/challenge
/progress

Solidity / Foundry

Test:

* BEES mint
* BEES transfer
* Challenge creation
* Challenge funding
* Challenge completion
* Reward claiming
* Failed challenges
* Access control

⸻

33. Testing Methodology

Every feature follows this process:

1. BUILD
2. RUN
3. TEST NORMAL CASE
4. TEST FAILURE CASE
5. CHECK DATABASE / API / UI
6. FIX BUGS
7. RETEST
8. CONFIRM PASS
9. COMMIT TO GITHUB
10. MOVE TO NEXT FEATURE

Testing categories:

Feature Test

Does the feature work normally?

Edge-Case Test

What happens with unusual input?

Integration Test

Does it work with the other parts?

Demo Test

Does it work as expected in the final user journey?

⸻

34. Build Order

The system must be built incrementally.

Phase 1 — Foundation

* React/Vite
* Node.js
* Express
* TypeScript
* Project structure

Phase 2 — Authentication

* Register
* Login
* Logout
* Protected routes

Phase 3 — Habits

* Create
* Edit
* Delete
* Pause
* Resume
* Complete
* Miss
* History

Phase 4 — Analytics

* Streaks
* Completion percentage
* Consistency score
* Behavioral patterns

Phase 5 — Agent

* LLM
* Agent tools
* Analytics access
* Recommendations

Phase 6 — Sibyl Memory

* Save memory
* Search memory
* Retrieve memory
* Use memory in reasoning
* Fresh-session recall

Phase 7 — Challenges

* Agent proposal
* User confirmation
* Challenge creation
* Progress tracking
* Success/failure

Phase 8 — Blockchain

* BEES token
* Challenge contract
* Foundry tests
* Base Sepolia deployment
* Wallet connection
* Funding
* Reward claiming

Phase 9 — Telegram

* Python bot
* Account linking
* Habit commands
* Progress
* Accountability messages

Phase 10 — Integration

Connect:

React
 ↓
Node
 ↓
PostgreSQL
Agent
 ↓
Sibyl Memory
Agent
 ↓
Challenges
 ↓
Blockchain
Telegram
 ↓
Python
 ↓
Node API

Phase 11 — Full Testing

Run the entire system locally.

Phase 12 — Deployment

Deploy:

* React frontend
* Node backend
* PostgreSQL
* Python Telegram bot
* Base Sepolia contracts

⸻

35. Final User Journey

User creates account
        ↓
Creates "Workout" habit
        ↓
Completes/misses workouts
        ↓
Habitra tracks behavior
        ↓
Analytics identifies pattern
        ↓
Agent remembers important context
        ↓
Sibyl stores the memory
        ↓
Agent recommends better behavior
        ↓
Agent proposes challenge
        ↓
User accepts
        ↓
User connects wallet
        ↓
User signs challenge transaction
        ↓
Challenge becomes active
        ↓
Habitra tracks progress
        ↓
Agent keeps user accountable
        ↓
Challenge completed
        ↓
BEES reward becomes claimable
        ↓
User signs claim
        ↓
BEES received
        ↓
Agent remembers the outcome
        ↓
Future recommendations improve

⸻

36. MVP Success Criteria

The MVP is successful when all seven core capabilities work:

1. User can create an account.
2. User can create and complete habits.
3. Habitra calculates behavioral analytics.
4. Autonomous Accountability Agent understands behavior.
5. Sibyl Memory allows the agent to remember across sessions.
6. Agent creates personalized challenges and keeps users accountable.
7. Base Sepolia + BEES provides the on-chain reward mechanism.

Telegram is the second interface, not a separate product.

⸻

37. Important Development Rule

Do NOT build the entire system at once.

Development must happen feature-by-feature.

For every feature:

Build
 ↓
Run
 ↓
Test
 ↓
Fix
 ↓
Retest
 ↓
Confirm PASS
 ↓
Commit
 ↓
Next feature

Do not move to the next major feature until the current feature passes its tests.

The PRD is the source of truth for the product, architecture, requirements, and build order.