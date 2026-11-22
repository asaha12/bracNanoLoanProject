# BRAC Nano Loan Eligibility & Credit Score QA Verification Tool

A specialized JavaScript / Node.js automated QA verification engine for the **BRAC Microfinance Nano Loan Project** (CR ID: `BBMFV2-7826`). 

This tool evaluates any BRAC member's loan and savings history against the 5-stage Nano Loan eligibility criteria and 4 credit scoring parameters specified in the Change Request Document (SRS). It provides a full step-by-step mathematical calculation breakdown and performs automated side-by-side reconciliation against the system batch run tables in the database.

---

## 📌 Features

- **5-Stage Sequential Eligibility Evaluation**:
  1. **Step 1: Minimum Loan Cycle**: Evaluates general loan counts within a 4-year history window (Monthly frequency, status 1 & 2).
  2. **Step 2: Running Loan Repayment Requirement**: Calculates principal repaid percentage on the latest active loan ($\ge 30\%$ threshold; automatically skipped if no running loan exists).
  3. **Step 3: Due Month Repayment Criteria**: Validates installment repayment timeliness within repayment months over the evaluation period (12 months).
  4. **Step 4: Eligible Loan Ceiling Calculation**: Computes average disbursed amount of the latest 2 general loans $\times 20\%$, enforcing project-specific minimum and maximum caps (Dabi: BDT 20k–50k, Progoti: BDT 20k–100k).
  5. **Step 5: Credit Scoring Assessment**: Computes individual loan scores and averages across 4 behavioral parameters:
     - *Parameter 1*: Installment Payment Behavior (Timeliness per installment)
     - *Parameter 2*: Savings Paid with Loan Installment (Compulsory savings deposit ratio)
     - *Parameter 3*: Savings Adjustment of Previous Loans (Loan settlement via savings)
     - *Parameter 4*: Savings Withdrawal Before Repayment (Compulsory savings withdrawals within 7 days of due date)
     - *Final Score Formula*: $\frac{\text{Param 1} + \text{Param 2} + \text{Param 3} + \text{Param 4}}{4} \ge 3.0$
- **Automated Database Reconciliation**: Automatically matches computed values against `credit_risk_model_eligible_member`, `credit_risk_model_eligibility_candidate`, and `credit_risk_model_eligibility_score_detail`.
- **Dynamic Real-Time Calculation**: For members whose branch was not part of the previous batch run (e.g. Branch 391), computes eligibility directly from underlying core ERP tables.

---

## 🛠️ Prerequisites

1. **Node.js**: Version `18.x`, `20.x`, or higher installed.
2. **Network / VPN Access**: The database host is on an internal network (`10.150.150.52:4550`). Ensure your VPN (e.g. OpenFortiVPN) is active when running against the live database.

---

## 📥 Installation

1. Navigate to the project directory:
   ```bash
   cd /home/a/Documents/bracNanoLoanProject
   ```

2. Install dependencies:
   ```bash
   npm install
   ```
   *(Only requires the standard `pg` PostgreSQL client library).*

---

## 🚀 How to Run

### Option 1: Direct Command-Line Argument (Fastest)
Pass the Member ID directly as a command-line argument:
```bash
node check_member.js <MEMBER_ID>
```
Or using npm:
```bash
npm run check -- <MEMBER_ID>
```

#### Examples:
```bash
# 1. Eligible Progoti Member (Ceiling capped at 100k, Final Score: 4.750)
node check_member.js 16292015

# 2. Eligible Dabi Member (Ceiling: 22k, Final Score: 4.000)
node check_member.js 16273461

# 3. Candidate Failed at Step 2 (Running loan repaid 22.4%, requires 30.0%)
node check_member.js 14703103

# 4. Candidate Failed at Step 4 (Computed ceiling 15,000 below project min 20,000)
node check_member.js 14582259

# 5. Member from Branch 391 (Sonagazi) - Real-time Core ERP Evaluation
node check_member.js 34145511
```

---

### Option 2: Interactive Prompt Mode
Run the script without arguments, and it will prompt you to enter a Member ID:
```bash
node check_member.js
```
**Terminal Output:**
```text
Please enter Member ID (e.g. 16273461, 34145511): 16292015
```

---

## 📋 Sample Terminal Output Breakdown

```text
================================================================================
  BRAC NANO LOAN - MEMBER ELIGIBILITY & CREDIT SCORE QA BREAKDOWN
================================================================================

👤 MEMBER INFORMATION:
  - Member ID        : 16292015
  - Member Number    : 16292015
  - Member Name      : Md Anser Ali Ali
  - Branch Office    : [BD400223] Nangalkot (ID: 342)
  - Project          : Progoti (ID: 2)
  - Evaluation Date  : 2026-10-31
  - Assessment Status: ✅ ELIGIBLE
  - Min Loan Ceiling : BDT 20,000.00
  - Max Loan Ceiling : BDT 100,000.00
  - Final Score      : 4.750 (Threshold: 3)

--------------------------------------------------------------------------------
  STEP 1: Minimum Loan Cycle Evaluation (Sequence 1)
--------------------------------------------------------------------------------
  Configured Rule  : Minimum 2 General Loans within last 4 years (after 2022-10-31)
  Actual Evaluated : 3 General Loans found
  Step Verdict     : ✅ PASS

--------------------------------------------------------------------------------
  STEP 2: Running Loan Repayment Requirement (Sequence 2)
--------------------------------------------------------------------------------
  Status           : ℹ️ Member has no active running loan (all loans closed).
  Rule Impact      : Step 2 criteria is automatically SKIPPED as per SRS business exception.
  Step Verdict     : ✅ PASS (Skipped)

--------------------------------------------------------------------------------
  STEP 3: Due Month Repayment Criteria (Sequence 3)
--------------------------------------------------------------------------------
  Evaluation Period: Last 12 Months (since 2025-10-31)
  Rule             : All repayments must be completed within the respective repayment month
  Step Verdict     : ✅ PASS

--------------------------------------------------------------------------------
  STEP 4: Eligible Loan Amount & Ceiling Calculation (Sequence 4)
--------------------------------------------------------------------------------
  Number of Loans to Average : 2 loans
  Loans Averaged             : 48449049 (BDT 600,000.00), 41939313 (BDT 500,000.00)
  Average Disbursed Amount   : BDT 550,000.00
  Eligible Loan Percentage   : 20%
  Formula                    : Average Disbursed * 20%
  Calculated Ceiling         : BDT 110,000.00
  Project Ceiling Range      : BDT 20,000.00 - BDT 100,000.00
  Step Verdict               : ✅ PASS
  Final Min Eligible Amount  : BDT 20,000.00
  Final Max Eligible Amount  : BDT 100,000.00 (Capped at Progoti max ceiling)

--------------------------------------------------------------------------------
  STEP 5: Credit Risk Scoring & Final Score (Sequence 5)
--------------------------------------------------------------------------------
  1. Installment Payment Behavior Score : 5.000
  2. Savings Paid with Installment Score: 4.000
  3. Savings Adjustment of Prev Loan    : 5.000
  4. Savings Withdrawal Before Repayment: 5.000

  Final Credit Score Calculation:
  Formula          : (Param1 + Param2 + Param3 + Param4) / 4
                   : (5.000 + 4.000 + 5.000 + 5.000) / 4
  Final Score      : 4.750
  Required Score   : >= 3
  Step Verdict     : ✅ PASS

================================================================================
  QA DATABASE RECONCILIATION
================================================================================
  [Found in credit_risk_model_eligible_member table - Run ID: 2]
  ---------------------------------------------------------------------
  Metric                   | Engine Calculated  | Database Stored    | QA Match?
  -------------------------+--------------------+--------------------+----------
  Eligibility Status       | ELIGIBLE           | ELIGIBLE           | ✅ MATCH
  Min Eligible Amount      | 20000              | 20000              | ✅ MATCH
  Max Eligible Amount      | 100000             | 100000             | ✅ MATCH
  Param 1 Score            | 5                  | 5                  | ✅ MATCH
  Param 2 Score            | 4                  | 4                  | ✅ MATCH
  Param 3 Score            | 5                  | 5                  | ✅ MATCH
  Param 4 Score            | 5                  | 5                  | ✅ MATCH
  Final Score              | 4.75               | 4.75               | ✅ MATCH
================================================================================
```

---

## 🗂️ Project Structure

```text
bracNanoLoanProject/
├── check_member.js               # CLI Entrypoint (interactive prompt or CLI args)
├── nanoLoanEngine.js             # Core 5-stage calculation engine & scoring algorithms
├── reporter.js                   # Output formatter, breakdown generator & DB reconciler
├── db.js                         # Database pool connection configuration
├── NANO_LOAN_QA_KNOWLEDGE_BASE.md# Comprehensive SRS business rules & DB schema reference
├── package.json                  # Project dependencies & scripts
├── 16072026_BBMFV2-7826...pdf    # Change Request Specification Document (SRS)
└── README.md                     # Project documentation & usage instructions
```

---

## 🔐 Credentials & Environment Reference

- **ERP UI**: `https://env102-erp.bracits.net`
- **Eligibility Report**: `https://env102-erp.bracits.net/node/mfDashboard#!/microfinanceReport/nanoLoanEligibilityReport`
- **Assessment Configuration**: `https://env102-erp.bracits.net/node/mfDashboard#!/creditEligibilityAssessmentConf/create`
- **Branch Office [0459] Login**: User: `97816` / Pass: `2ieRG*yh`
- **Head Office Login**: User: `mashuk` / Pass: `e8SP$YC@`
- **Database Configuration** (`db.js`):
  - Host: `10.150.150.52`
  - Port: `4550`
  - Database: `sbicloud_bd`
  - User: `aditya_2344`

---

## 📖 Additional Documentation
For complete mathematical formulas, database table mappings, and scoring band threshold tables, see:
- [NANO_LOAN_QA_KNOWLEDGE_BASE.md](NANO_LOAN_QA_KNOWLEDGE_BASE.md)
