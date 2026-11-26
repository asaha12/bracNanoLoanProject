# BRAC Nano Loan Eligibility & Credit Score QA Verification Tool

A modular Node.js automated QA verification engine for the **BRAC Microfinance Nano Loan Project** (CR ID: `BBMFV2-7826`).

This tool evaluates any BRAC member's loan and savings history against the 5-stage Nano Loan eligibility criteria and 4 credit scoring parameters specified in the Change Request Document (SRS). On **every run**, it reads externalized settings from `config/config.properties` and fetches the **live Loan Product configuration** (by `loan.product.id`) and **live Credit Risk Model rules** directly from the database before computing the full step-by-step breakdown and reconciling against the latest batch run tables.

---

## 📌 Key Features

- **Externalized Configuration (`config/config.properties`)**:
  - Centralized properties file for `base.url`, `loan.product.dabi.id` (`235`), `loan.product.progoti.id` (`234`), `office.id`, `branch.office.code`, branch credentials (`branch.username` / `branch.password`), head office credentials (`head.office.username` / `head.office.password`), and PostgreSQL DB settings.
- **Live ERP Credential & Office Validation (Every Run)**:
  - Authenticates **both** Branch (`branch.username` / `branch.password`) and Head Office (`head.office.username` / `head.office.password`) credentials live against BRAC ERP's **Keycloak OIDC Identity Provider** (`<base.url>/idp/realms/brac/...`) and `application_user` table on every run — immediately aborting execution if credentials are invalid, locked, or expired.
  - Validates `office.id` against `branch.office.code` in `physical_office_info` (e.g. `office.id=342` → `[0459] Monirampur`), aborting with the exact matching `office.id` hint if misconfigured.
- **Live Loan Product & Assessment Rule Verification (Every Run)**:
  - Queries `loan_product`, `project_loan_product_mapping`, `loan_product_interest_rate`, `loan_product_policy`, and `loan_product_details` live on every execution for **both Dabi and Progoti** loan products, verifying that each product is active and mapped to its project, and matching the evaluated member's project to the corresponding product.
  - Queries all active (`domain_status_id = 1`) `credit_risk_model_conf_*` tables live on every execution and flags any **Configuration Drift** versus the latest eligibility batch run snapshot.
- **5-Stage Sequential Eligibility Evaluation**:
  1. **Step 1: Minimum Loan Cycle** (General loan count within lookback window).
  2. **Step 2: Running Loan Repayment Requirement** (Principal repaid % on latest active loan; auto-skipped if no running loan).
  3. **Step 3: Due Month Repayment Criteria** (Repayment discipline over evaluation period).
  4. **Step 4: Eligible Loan Ceiling Calculation** (Average disbursed amount of latest loans × eligible %, bounded by live Loan Product min/max ceilings).
  5. **Step 5: Credit Scoring Assessment** (4 behavioral parameters evaluated against live DB score bands).
- **Automated Database Reconciliation**: Side-by-side comparison against `credit_risk_model_eligible_member`, `credit_risk_model_eligibility_candidate`, and `credit_risk_model_eligibility_score_detail`.

---

## 🗂️ Project Structure

```text
bracNanoLoanProject/
├── config/
│   ├── config.properties              # Active environment, credentials, office & loan product ID
│   └── config.properties.example      # Reference template for new environments
├── src/
│   ├── config/
│   │   ├── propertiesParser.js        # Zero-dependency .properties file parser
│   │   └── appConfig.js               # Typed configuration loader & URL builders
│   ├── db/
│   │   └── connection.js              # PostgreSQL Client/Pool factory driven by config.properties
│   ├── services/
│   │   ├── credentialService.js       # Live Keycloak OIDC + application_user auth for Branch & HO logins
│   │   ├── loanProductService.js      # Live DB loader for configured Dabi & Progoti loan products
│   │   ├── assessmentConfigService.js # Live DB loader for credit_risk_model_conf_* + drift detection
│   │   └── officeService.js           # Live physical_office_info lookup & branch.office.code verification
│   ├── engine/
│   │   ├── bandEvaluator.js           # Dynamic score band matcher from live DB bands
│   │   └── nanoLoanEvaluator.js       # 5-stage Nano Loan eligibility & credit scoring engine
│   ├── reporters/
│   │   └── consoleReporter.js         # Structured terminal report, drift alerts & DB reconciler
│   ├── utils/
│   │   └── dateUtils.js               # Asia/Dhaka (UTC+6) date math & Bangladesh working-day helper
│   └── index.js                       # Main CLI entrypoint (interactive prompt + CLI arg support)
├── check_member.js                    # Backward-compatible root CLI wrapper -> src/index.js
├── package.json                       # Dependencies & npm scripts
├── NANO_LOAN_QA_KNOWLEDGE_BASE.md     # SRS business rules & DB schema reference
└── README.md                          # Documentation & usage guide
```

---

## ⚙️ Configuration (`config/config.properties`)

Update `config/config.properties` whenever you switch environment, office, credentials, or create/modify a Nano Loan product:

```properties
# ERP Application & Environment
base.url=https://env102-erp.bracits.net

# Trailing IDs from: https://env102-erp.bracits.net/node/mfDashboard#!/loanProduct/show/id=<ID>
# Both Dabi (Project ID: 1) and Progoti (Project ID: 2) are checked live from DB on every run
# and verified against the input member's project.
loan.product.dabi.id=235
loan.product.progoti.id=234

# Office & Branch Configuration (physical_office_info.id, e.g. 342 for [0459] Monirampur)
office.id=342
branch.office.code=0459
branch.username=97816
branch.password=a&RKdT4u

# Head Office Credentials
head.office.username=mashuk
head.office.password=Xe^9uv%P

# Database Configuration
db.host=10.150.150.52
db.port=4550
db.name=sbicloud_bd
db.user=aditya_2344
db.password=Th7T0fKG3$DYJ53E
db.connection.timeout.ms=10000

# Optional Overrides
evaluation.business.date=
eligibility.run.id=latest
```

> **Note**: You can also point to an alternate properties file at runtime via `CONFIG_PROPERTIES_PATH=/path/to/custom.properties`.

---

## 🛠️ Prerequisites & Installation

1. **Node.js** `18.x` / `20.x` or higher.
2. **VPN Access** to the internal database host (`10.150.150.52:4550`).
3. Install dependencies:
   ```bash
   npm install
   ```

---

## 🚀 How to Run

### Option 1: Interactive Prompt Mode (Default)
Run the codebase and enter the Member ID when prompted:
```bash
npm start
# or
node check_member.js
```
**Terminal Prompt:**
```text
Please enter Member ID (e.g. 16273461, 16292015, 34145511): 16273461
```

### Option 2: Direct Command-Line Argument
Pass the Member ID directly:
```bash
node check_member.js 16273461
# or
npm run check -- 16292015
```

#### Sample Test Members
- `16273461` — Eligible Dabi Member (Project 1, verified against `loan.product.dabi.id=235`)
- `16292015` — Eligible Progoti Member (Project 2, verified against `loan.product.progoti.id=234`)
- `14703103` — Failed at Step 2 (Running loan repaid below threshold)
- `14582259` — Failed at Step 4 (Computed ceiling below project minimum)
- `34145511` — Real-time Core ERP Evaluation (Member outside previous batch run)

---

## 📖 Additional Documentation
For complete mathematical formulas, database table mappings, and scoring band threshold tables, see:
- [NANO_LOAN_QA_KNOWLEDGE_BASE.md](NANO_LOAN_QA_KNOWLEDGE_BASE.md)
