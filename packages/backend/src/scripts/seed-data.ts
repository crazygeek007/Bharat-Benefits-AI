/**
 * Comprehensive scheme seed data — 100+ real Indian government welfare schemes
 * across all 12 categories, with eligibility criteria, application steps,
 * required documents, and compatibility relationships.
 *
 * Sources: official central and state government portals.
 */

export interface SeedDocument {
  documentName: string;
  description: string;
  format: string;
  required: boolean;
}

export interface SeedApplicationStep {
  stepNumber: number;
  action: string;
  expectedOutcome: string;
}

export interface SeedScheme {
  slug: string;
  name: string;
  description: string;
  ministry: string;
  state: string | null;
  category: string;
  sourceUrl: string;
  benefitType: 'monetary' | 'non-monetary';
  benefitAmount: number | null;
  deadline: Date | null;
  applicationMode: 'online' | 'offline' | 'hybrid';
  applicationUrl: string | null;
  eligibilityCriteria: Array<{
    field: string;
    operator: string;
    value: unknown;
    description: string;
  }>;
  applicationSteps: SeedApplicationStep[];
  documents: SeedDocument[];
  trustScore: number;
}

export interface SeedRelationship {
  schemeSlug: string;
  relatedSchemeSlug: string;
  relationshipType: 'can_combine_with' | 'cannot_combine_with' | 'prerequisite_scheme';
  officialRule: string;
}

const D = {
  aadhaar: { documentName: 'Aadhaar Card', description: '12-digit UIDAI identification', format: 'Original or photocopy', required: true },
  pan: { documentName: 'PAN Card', description: 'Permanent Account Number', format: 'Original or photocopy', required: true },
  bank: { documentName: 'Bank Account Passbook', description: 'Active bank account in applicant\'s name', format: 'First page', required: true },
  income: { documentName: 'Income Certificate', description: 'Issued by Tehsildar', format: 'Recent (within 6 months)', required: true },
  domicile: { documentName: 'Domicile / Residence Proof', description: 'Proof of state residence', format: 'Voter ID/ration card/utility bill', required: true },
  photo: { documentName: 'Passport-Size Photograph', description: 'Recent photograph', format: 'JPEG/PNG, white background', required: true },
  caste: { documentName: 'Caste Certificate', description: 'For SC/ST/OBC applicants', format: 'Issued by competent authority', required: false },
  ration: { documentName: 'Ration Card', description: 'BPL/AAY ration card', format: 'Original', required: true },
  birth: { documentName: 'Birth Certificate', description: 'Issued by municipal corporation/panchayat', format: 'Original', required: true },
  land: { documentName: 'Land Records', description: 'Khata/Khasra/Patta documents', format: 'Original or attested', required: true },
};

// Quick scheme builder helpers to keep entries compact
const central = (s: string) => null;

export const SCHEMES: SeedScheme[] = [
  // ─── AGRICULTURE (15) ────────────────────────────────────────────────────
  {
    slug: 'pm-kisan',
    name: 'Pradhan Mantri Kisan Samman Nidhi (PM-KISAN)',
    description: 'Provides income support of Rs. 6,000 per year to all eligible farmer families across the country, payable in three equal installments of Rs. 2,000 every four months.',
    ministry: 'Ministry of Agriculture & Farmers Welfare',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://pmkisan.gov.in/',
    benefitType: 'monetary',
    benefitAmount: 6000,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: 'https://pmkisan.gov.in/RegistrationForm.aspx',
    eligibilityCriteria: [
      { field: 'occupation', operator: 'eq', value: 'Farmer', description: 'Must be a small or marginal farmer' },
      { field: 'age', operator: 'gte', value: 18, description: 'Must be 18 years or older' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Visit pmkisan.gov.in and click "New Farmer Registration"', expectedOutcome: 'Registration form opens' },
      { stepNumber: 2, action: 'Enter Aadhaar number and verify via OTP', expectedOutcome: 'Aadhaar verified' },
      { stepNumber: 3, action: 'Fill in land ownership details and bank account', expectedOutcome: 'Form submitted' },
      { stepNumber: 4, action: 'Verification by state government officials', expectedOutcome: 'Approval within 30 days' },
    ],
    documents: [D.aadhaar, D.bank, D.land],
    trustScore: 95,
  },
  {
    slug: 'kisan-credit-card',
    name: 'Kisan Credit Card Scheme (KCC)',
    description: 'Provides farmers timely access to credit for cultivation, post-harvest, marketing, and farm asset maintenance at concessional 4% interest rate.',
    ministry: 'Ministry of Agriculture & Farmers Welfare',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://www.myscheme.gov.in/schemes/kcc',
    benefitType: 'monetary',
    benefitAmount: 300000,
    deadline: null,
    applicationMode: 'hybrid',
    applicationUrl: null,
    eligibilityCriteria: [
      { field: 'occupation', operator: 'eq', value: 'Farmer', description: 'Must be a farmer' },
      { field: 'age', operator: 'between', value: [18, 75], description: 'Age 18-75' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Visit nearest commercial bank or cooperative bank', expectedOutcome: 'Meet bank officer' },
      { stepNumber: 2, action: 'Fill KCC application form with required documents', expectedOutcome: 'Application submitted' },
      { stepNumber: 3, action: 'Bank verifies and processes within 14 days', expectedOutcome: 'Credit limit sanctioned' },
    ],
    documents: [D.aadhaar, D.pan, D.bank, D.land, D.photo],
    trustScore: 95,
  },
  {
    slug: 'pm-fasal-bima',
    name: 'Pradhan Mantri Fasal Bima Yojana (PMFBY)',
    description: 'Crop insurance scheme providing comprehensive risk coverage to farmers against crop loss due to natural risks. Premium 1.5%-5% of sum insured.',
    ministry: 'Ministry of Agriculture & Farmers Welfare',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://pmfby.gov.in/',
    benefitType: 'monetary',
    benefitAmount: 200000,
    deadline: new Date('2026-07-31'),
    applicationMode: 'hybrid',
    applicationUrl: 'https://pmfby.gov.in/farmerLogin',
    eligibilityCriteria: [
      { field: 'occupation', operator: 'eq', value: 'Farmer', description: 'Must be a farmer cultivating notified crops' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Visit pmfby.gov.in or your bank branch', expectedOutcome: 'Application portal accessed' },
      { stepNumber: 2, action: 'Select crop and enter sown area', expectedOutcome: 'Crop registered' },
      { stepNumber: 3, action: 'Pay premium and receive policy', expectedOutcome: 'Coverage active' },
    ],
    documents: [D.aadhaar, D.bank, D.land, { documentName: 'Sowing Certificate', description: 'Proof of crop sown', format: 'From village officer', required: true }],
    trustScore: 95,
  },
  {
    slug: 'pmksy',
    name: 'Pradhan Mantri Krishi Sinchayee Yojana (PMKSY)',
    description: 'Improves on-farm water use efficiency through micro-irrigation (drip and sprinkler systems) with subsidies of 55% for small farmers and 45% for others.',
    ministry: 'Ministry of Agriculture & Farmers Welfare',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://pmksy.gov.in/',
    benefitType: 'monetary',
    benefitAmount: 100000,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [
      { field: 'occupation', operator: 'eq', value: 'Farmer', description: 'Must own or cultivate agricultural land' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Apply at District Agriculture Office or via state portal', expectedOutcome: 'Application submitted' },
      { stepNumber: 2, action: 'Field inspection by agriculture officer', expectedOutcome: 'Approval' },
      { stepNumber: 3, action: 'Subsidy released after equipment installation', expectedOutcome: 'Funds credited' },
    ],
    documents: [D.aadhaar, D.bank, D.land],
    trustScore: 92,
  },
  {
    slug: 'soil-health-card',
    name: 'Soil Health Card Scheme',
    description: 'Provides soil health cards to farmers every 2 years with crop-wise nutrient recommendations to improve productivity and reduce fertilizer costs.',
    ministry: 'Ministry of Agriculture & Farmers Welfare',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://soilhealth.dac.gov.in/',
    benefitType: 'non-monetary',
    benefitAmount: null,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [
      { field: 'occupation', operator: 'eq', value: 'Farmer', description: 'Must own agricultural land' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Soil samples collected by agriculture department staff', expectedOutcome: 'Samples sent for testing' },
      { stepNumber: 2, action: 'Receive Soil Health Card with recommendations', expectedOutcome: 'Card issued (free)' },
    ],
    documents: [D.aadhaar, D.land],
    trustScore: 90,
  },
  {
    slug: 'pkvy',
    name: 'Paramparagat Krishi Vikas Yojana (PKVY)',
    description: 'Promotes organic farming through cluster approach. Provides Rs. 50,000/hectare over 3 years for organic inputs, certification, and value addition.',
    ministry: 'Ministry of Agriculture & Farmers Welfare',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://pgsindia-ncof.gov.in/PKVY/Index.aspx',
    benefitType: 'monetary',
    benefitAmount: 50000,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [
      { field: 'occupation', operator: 'eq', value: 'Farmer', description: 'Group of 50 farmers forming a cluster' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Form cluster of 50 farmers (50 hectares)', expectedOutcome: 'Cluster registered' },
      { stepNumber: 2, action: 'Apply through state organic farming agency', expectedOutcome: 'Cluster approved' },
      { stepNumber: 3, action: 'Receive financial assistance and training', expectedOutcome: 'Funds disbursed annually' },
    ],
    documents: [D.aadhaar, D.bank, D.land],
    trustScore: 88,
  },
  {
    slug: 'enam',
    name: 'electronic National Agriculture Market (e-NAM)',
    description: 'Online trading platform for agricultural commodities, connecting farmers to buyers across mandis. Reduces middleman dependency and ensures fair prices.',
    ministry: 'Ministry of Agriculture & Farmers Welfare',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://enam.gov.in/web/',
    benefitType: 'non-monetary',
    benefitAmount: null,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: 'https://enam.gov.in/web/registration',
    eligibilityCriteria: [
      { field: 'occupation', operator: 'eq', value: 'Farmer', description: 'Must be a farmer or trader' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Register on enam.gov.in with KYC documents', expectedOutcome: 'Account created' },
      { stepNumber: 2, action: 'Get verified by APMC mandi officer', expectedOutcome: 'Verified seller' },
      { stepNumber: 3, action: 'Upload produce details and accept bids', expectedOutcome: 'Direct online sale' },
    ],
    documents: [D.aadhaar, D.pan, D.bank],
    trustScore: 90,
  },
  {
    slug: 'pmmsy',
    name: 'Pradhan Mantri Matsya Sampada Yojana (PMMSY)',
    description: 'Comprehensive scheme for sustainable development of fisheries sector with investment of Rs. 20,050 crore. Subsidies for fish farming, equipment, and infrastructure.',
    ministry: 'Ministry of Fisheries, Animal Husbandry and Dairying',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://pmmsy.dof.gov.in/',
    benefitType: 'monetary',
    benefitAmount: 200000,
    deadline: null,
    applicationMode: 'hybrid',
    applicationUrl: null,
    eligibilityCriteria: [
      { field: 'age', operator: 'gte', value: 18, description: '18 years or older' },
      { field: 'occupation', operator: 'in', value: ['Farmer', 'Self-Employed', 'Other'], description: 'Fish farmer or aspiring entrepreneur' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Apply via state fisheries department', expectedOutcome: 'Application registered' },
      { stepNumber: 2, action: 'Submit project proposal and DPR', expectedOutcome: 'Proposal evaluated' },
      { stepNumber: 3, action: 'Subsidy released in tranches', expectedOutcome: 'Funds credited' },
    ],
    documents: [D.aadhaar, D.bank, D.pan],
    trustScore: 90,
  },
  {
    slug: 'national-livestock-mission',
    name: 'National Livestock Mission (NLM)',
    description: 'Promotes entrepreneurship in poultry, sheep, goat, piggery and fodder development sectors. Provides 50% capital subsidy up to Rs. 50 lakh.',
    ministry: 'Ministry of Fisheries, Animal Husbandry and Dairying',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://www.nlm.udyamimitra.in/',
    benefitType: 'monetary',
    benefitAmount: 5000000,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: 'https://www.nlm.udyamimitra.in/',
    eligibilityCriteria: [
      { field: 'age', operator: 'gte', value: 18, description: '18 years or older' },
      { field: 'occupation', operator: 'in', value: ['Self-Employed', 'Farmer', 'Other'], description: 'Individuals, FPOs, SHGs, JLGs' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Register on NLM portal', expectedOutcome: 'Account created' },
      { stepNumber: 2, action: 'Submit DPR and supporting documents', expectedOutcome: 'Application reviewed' },
      { stepNumber: 3, action: 'Get bank loan and subsidy disbursed', expectedOutcome: 'Project funded' },
    ],
    documents: [D.aadhaar, D.pan, D.bank, { documentName: 'Detailed Project Report', description: 'Business plan with financials', format: 'PDF', required: true }],
    trustScore: 88,
  },
  {
    slug: 'agri-clinics',
    name: 'Agri-Clinics and Agri-Business Centres (ACABC)',
    description: 'Trains agriculture graduates to set up agri-business centres providing services to farmers. Includes 2-month training and bank loans up to Rs. 20 lakh.',
    ministry: 'Ministry of Agriculture & Farmers Welfare',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://www.agriclinics.net/',
    benefitType: 'monetary',
    benefitAmount: 2000000,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: 'https://www.agriclinics.net/',
    eligibilityCriteria: [
      { field: 'age', operator: 'between', value: [18, 60], description: 'Age between 18 and 60' },
      { field: 'educationLevel', operator: 'in', value: ['Graduate', 'Post-Graduate', 'Doctorate'], description: 'Agriculture graduate or related field' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Apply at Nodal Training Institute', expectedOutcome: 'Selected for training' },
      { stepNumber: 2, action: 'Complete 2-month training programme', expectedOutcome: 'Certificate issued' },
      { stepNumber: 3, action: 'Apply for bank loan to start agri-clinic', expectedOutcome: 'Loan disbursed' },
    ],
    documents: [D.aadhaar, D.pan, D.bank, { documentName: 'Graduation Certificate', description: 'Agriculture/related degree', format: 'Original', required: true }],
    trustScore: 88,
  },
  {
    slug: 'rkvy',
    name: 'Rashtriya Krishi Vikas Yojana (RKVY)',
    description: 'Centrally-sponsored scheme providing flexible funding to states for agriculture development, ensuring holistic growth and infrastructure for the agri-sector.',
    ministry: 'Ministry of Agriculture & Farmers Welfare',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://rkvy.nic.in/',
    benefitType: 'non-monetary',
    benefitAmount: null,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [
      { field: 'occupation', operator: 'eq', value: 'Farmer', description: 'Farmers benefit through state-implemented projects' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Benefits delivered through state agriculture department', expectedOutcome: 'Auto-eligible based on state schemes' },
    ],
    documents: [D.aadhaar],
    trustScore: 85,
  },
  {
    slug: 'pm-aasha',
    name: 'Pradhan Mantri Annadata Aay SanraksHan Abhiyan (PM-AASHA)',
    description: 'Ensures fair Minimum Support Prices (MSP) to farmers for pulses, oilseeds, and copra through procurement and price support mechanisms.',
    ministry: 'Ministry of Agriculture & Farmers Welfare',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://www.india.gov.in/spotlight/pm-aasha-scheme-comprehensive-coverage-msp-farmers',
    benefitType: 'monetary',
    benefitAmount: null,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [
      { field: 'occupation', operator: 'eq', value: 'Farmer', description: 'Farmers cultivating eligible crops' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Sell produce at state procurement agencies (NAFED, FCI)', expectedOutcome: 'MSP-based payment' },
    ],
    documents: [D.aadhaar, D.bank, D.land],
    trustScore: 88,
  },
  {
    slug: 'pm-vishwakarma',
    name: 'PM Vishwakarma Scheme',
    description: 'Supports traditional artisans and craftspeople with skill training, modern tools (toolkit incentive Rs. 15,000), credit support up to Rs. 3 lakh, and digital transactions incentive.',
    ministry: 'Ministry of Micro, Small and Medium Enterprises',
    state: null,
    category: 'Skill Development',
    sourceUrl: 'https://pmvishwakarma.gov.in/',
    benefitType: 'monetary',
    benefitAmount: 300000,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: 'https://pmvishwakarma.gov.in/',
    eligibilityCriteria: [
      { field: 'age', operator: 'gte', value: 18, description: 'Age 18 or above' },
      { field: 'occupation', operator: 'in', value: ['Self-Employed', 'Other'], description: 'Traditional artisan in 18 trades' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Register at pmvishwakarma.gov.in', expectedOutcome: 'Application submitted' },
      { stepNumber: 2, action: 'Verification at Common Service Centre', expectedOutcome: 'Verified by panchayat/ULB' },
      { stepNumber: 3, action: 'Receive ID card, toolkit voucher, and access training', expectedOutcome: 'Full benefits unlocked' },
    ],
    documents: [D.aadhaar, D.bank, D.pan, D.photo],
    trustScore: 92,
  },
  {
    slug: 'national-bee-keeping',
    name: 'National Beekeeping and Honey Mission (NBHM)',
    description: 'Promotes scientific beekeeping for development of agriculture and horticulture and rural employment. Subsidies for bee colonies, hives, and processing units.',
    ministry: 'Ministry of Agriculture & Farmers Welfare',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://nbb.gov.in/',
    benefitType: 'monetary',
    benefitAmount: 500000,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [
      { field: 'age', operator: 'gte', value: 18, description: '18+' },
      { field: 'occupation', operator: 'in', value: ['Farmer', 'Self-Employed', 'Other'], description: 'Farmers, beekeepers, FPOs, SHGs' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Apply via state horticulture mission', expectedOutcome: 'Application logged' },
      { stepNumber: 2, action: 'Project approved and subsidy released', expectedOutcome: 'Funds disbursed' },
    ],
    documents: [D.aadhaar, D.bank, D.land],
    trustScore: 85,
  },
  {
    slug: 'agri-infra-fund',
    name: 'Agriculture Infrastructure Fund (AIF)',
    description: 'Rs. 1 lakh crore financing facility for post-harvest infrastructure (warehouses, cold storage, sorting centres) with 3% interest subvention and credit guarantee.',
    ministry: 'Ministry of Agriculture & Farmers Welfare',
    state: null,
    category: 'Agriculture',
    sourceUrl: 'https://agriinfra.dac.gov.in/',
    benefitType: 'monetary',
    benefitAmount: 20000000,
    deadline: null,
    applicationMode: 'online',
    applicationUrl: 'https://agriinfra.dac.gov.in/',
    eligibilityCriteria: [
      { field: 'occupation', operator: 'in', value: ['Farmer', 'Self-Employed', 'Other'], description: 'Farmers, FPOs, agri-entrepreneurs, startups' },
      { field: 'age', operator: 'gte', value: 18, description: '18+' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Submit application on AIF portal', expectedOutcome: 'Application registered' },
      { stepNumber: 2, action: 'Get loan from partner bank', expectedOutcome: 'Loan sanctioned with interest subvention' },
    ],
    documents: [D.aadhaar, D.pan, D.bank, { documentName: 'DPR / Project Report', description: 'Business plan', format: 'PDF', required: true }],
    trustScore: 90,
  },

  // ─── HEALTHCARE (12) ─────────────────────────────────────────────────────
  {
    slug: 'ayushman-bharat',
    name: 'Ayushman Bharat - Pradhan Mantri Jan Arogya Yojana (PM-JAY)',
    description: 'World\'s largest health insurance scheme providing Rs. 5 lakh per family per year for secondary and tertiary care hospitalization to over 12 crore poor and vulnerable families.',
    ministry: 'Ministry of Health and Family Welfare',
    state: null,
    category: 'Healthcare',
    sourceUrl: 'https://pmjay.gov.in/',
    benefitType: 'non-monetary',
    benefitAmount: 500000,
    deadline: null,
    applicationMode: 'hybrid',
    applicationUrl: 'https://pmjay.gov.in/',
    eligibilityCriteria: [
      { field: 'incomeLevel', operator: 'lte', value: 250000, description: 'BPL/SECC criteria' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Check eligibility on pmjay.gov.in', expectedOutcome: 'Eligibility confirmed' },
      { stepNumber: 2, action: 'Visit nearest CSC or empanelled hospital', expectedOutcome: 'Verification' },
      { stepNumber: 3, action: 'Receive Ayushman Card', expectedOutcome: 'Card usable at any empanelled hospital' },
    ],
    documents: [D.aadhaar, D.ration, D.photo],
    trustScore: 95,
  },
  {
    slug: 'rashtriya-swasthya',
    name: 'Rashtriya Swasthya Bima Yojana (RSBY)',
    description: 'Health insurance for unorganized sector workers providing up to Rs. 30,000 per year for hospitalization at network hospitals.',
    ministry: 'Ministry of Labour & Employment',
    state: null,
    category: 'Healthcare',
    sourceUrl: 'https://www.india.gov.in/spotlight/rashtriya-swasthya-bima-yojana',
    benefitType: 'non-monetary',
    benefitAmount: 30000,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [
      { field: 'incomeLevel', operator: 'lte', value: 200000, description: 'BPL household' },
      { field: 'occupation', operator: 'in', value: ['Unemployed', 'Self-Employed', 'Other'], description: 'Unorganized sector worker' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Visit district enrollment camp', expectedOutcome: 'Enrollment officer identified' },
      { stepNumber: 2, action: 'Submit BPL ration card and Aadhaar', expectedOutcome: 'Verified' },
      { stepNumber: 3, action: 'Pay Rs. 30 fee and get smart card', expectedOutcome: 'Card issued' },
    ],
    documents: [D.aadhaar, D.ration],
    trustScore: 88,
  },
  {
    slug: 'janani-suraksha',
    name: 'Janani Suraksha Yojana (JSY)',
    description: 'Safe motherhood intervention promoting institutional delivery. Cash assistance of Rs. 1,400 (rural) / Rs. 1,000 (urban) for delivery and post-delivery care.',
    ministry: 'Ministry of Health and Family Welfare',
    state: null,
    category: 'Healthcare',
    sourceUrl: 'https://nhm.gov.in/index1.php?lang=1&level=3&sublinkid=841&lid=309',
    benefitType: 'monetary',
    benefitAmount: 1400,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [
      { field: 'gender', operator: 'eq', value: 'Female', description: 'Pregnant woman' },
      { field: 'age', operator: 'gte', value: 19, description: 'Age 19+' },
      { field: 'incomeLevel', operator: 'lte', value: 250000, description: 'BPL or SC/ST' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Register pregnancy at nearest government health centre', expectedOutcome: 'Registered' },
      { stepNumber: 2, action: 'Plan institutional delivery', expectedOutcome: 'Delivery scheduled' },
      { stepNumber: 3, action: 'Cash credited within 7 days of delivery', expectedOutcome: 'Amount credited' },
    ],
    documents: [D.aadhaar, D.bank, { documentName: 'BPL/Caste Certificate', description: 'BPL or SC/ST status proof', format: 'Original', required: true }],
    trustScore: 92,
  },
  {
    slug: 'pmsma',
    name: 'Pradhan Mantri Surakshit Matritva Abhiyan (PMSMA)',
    description: 'Free, comprehensive antenatal care to pregnant women on the 9th of every month at government health facilities by specialist doctors.',
    ministry: 'Ministry of Health and Family Welfare',
    state: null,
    category: 'Healthcare',
    sourceUrl: 'https://pmsma.nhp.gov.in/',
    benefitType: 'non-monetary',
    benefitAmount: null,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [
      { field: 'gender', operator: 'eq', value: 'Female', description: 'Pregnant woman in 2nd or 3rd trimester' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Visit any government health facility on 9th of the month', expectedOutcome: 'Free check-up by specialist' },
    ],
    documents: [D.aadhaar],
    trustScore: 92,
  },
  {
    slug: 'mission-indradhanush',
    name: 'Mission Indradhanush',
    description: 'Vaccination programme to immunize all children under 2 years and pregnant women against 12 vaccine-preventable diseases. Free vaccines at government health centres.',
    ministry: 'Ministry of Health and Family Welfare',
    state: null,
    category: 'Healthcare',
    sourceUrl: 'https://www.nhp.gov.in/mission-indradhanush_pg',
    benefitType: 'non-monetary',
    benefitAmount: null,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [
      { field: 'age', operator: 'lte', value: 2, description: 'Children under 2 years; also pregnant women' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Visit nearest Anganwadi centre, PHC, or sub-centre', expectedOutcome: 'Vaccination schedule received' },
      { stepNumber: 2, action: 'Bring child for scheduled vaccinations', expectedOutcome: 'Free vaccinations given' },
    ],
    documents: [D.aadhaar, D.birth],
    trustScore: 95,
  },
  {
    slug: 'poshan-abhiyaan',
    name: 'POSHAN Abhiyaan (National Nutrition Mission)',
    description: 'Multi-ministerial mission to reduce stunting, undernutrition, anaemia, and low birth weight. Free supplementary nutrition through Anganwadi centres.',
    ministry: 'Ministry of Women and Child Development',
    state: null,
    category: 'Healthcare',
    sourceUrl: 'https://poshanabhiyaan.gov.in/',
    benefitType: 'non-monetary',
    benefitAmount: null,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [
      { field: 'age', operator: 'lte', value: 6, description: 'Children 0-6 years; also pregnant/lactating women' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Register at local Anganwadi centre', expectedOutcome: 'Beneficiary registered' },
      { stepNumber: 2, action: 'Receive supplementary nutrition and growth monitoring', expectedOutcome: 'Free services' },
    ],
    documents: [D.aadhaar, D.birth],
    trustScore: 92,
  },
  {
    slug: 'free-drugs-service',
    name: 'Free Drugs Service Initiative',
    description: 'Provides essential medicines free of cost at all government health facilities including district hospitals, CHCs, PHCs and sub-centres.',
    ministry: 'Ministry of Health and Family Welfare',
    state: null,
    category: 'Healthcare',
    sourceUrl: 'https://nhm.gov.in/index1.php?lang=1&level=2&sublinkid=1078&lid=440',
    benefitType: 'non-monetary',
    benefitAmount: null,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [],
    applicationSteps: [
      { stepNumber: 1, action: 'Visit any government health facility', expectedOutcome: 'Free essential medicines provided' },
    ],
    documents: [D.aadhaar],
    trustScore: 90,
  },
  {
    slug: 'free-diagnostics',
    name: 'Free Diagnostics Service Initiative',
    description: 'Offers free essential diagnostic services (lab tests, X-rays, ultrasounds, ECG) at government health facilities to reduce out-of-pocket expenditure.',
    ministry: 'Ministry of Health and Family Welfare',
    state: null,
    category: 'Healthcare',
    sourceUrl: 'https://nhm.gov.in/',
    benefitType: 'non-monetary',
    benefitAmount: null,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [],
    applicationSteps: [
      { stepNumber: 1, action: 'Visit any government health facility', expectedOutcome: 'Free diagnostic services' },
    ],
    documents: [D.aadhaar],
    trustScore: 90,
  },
  {
    slug: 'national-tb-elimination',
    name: 'National Tuberculosis Elimination Programme (NTEP)',
    description: 'Provides free TB diagnosis and treatment plus Rs. 500/month nutritional support (Nikshay Poshan Yojana) to TB patients during treatment.',
    ministry: 'Ministry of Health and Family Welfare',
    state: null,
    category: 'Healthcare',
    sourceUrl: 'https://tbcindia.gov.in/',
    benefitType: 'monetary',
    benefitAmount: 6000,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [
      { field: 'age', operator: 'gte', value: 0, description: 'TB patients of any age' },
    ],
    applicationSteps: [
      { stepNumber: 1, action: 'Get diagnosed at any government health facility', expectedOutcome: 'Free TB testing' },
      { stepNumber: 2, action: 'Notification on Nikshay portal triggers benefits', expectedOutcome: 'Rs. 500/month credited during treatment' },
    ],
    documents: [D.aadhaar, D.bank],
    trustScore: 95,
  },
  {
    slug: 'national-health-mission',
    name: 'National Health Mission (NHM)',
    description: 'Provides accessible, affordable, quality healthcare to rural and urban populations through public health systems strengthening.',
    ministry: 'Ministry of Health and Family Welfare',
    state: null,
    category: 'Healthcare',
    sourceUrl: 'https://nhm.gov.in/',
    benefitType: 'non-monetary',
    benefitAmount: null,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [],
    applicationSteps: [
      { stepNumber: 1, action: 'Visit any government health facility', expectedOutcome: 'Free services' },
    ],
    documents: [D.aadhaar],
    trustScore: 92,
  },
  {
    slug: 'mental-health-programme',
    name: 'National Mental Health Programme (NMHP)',
    description: 'Provides mental health services through District Mental Health Programme. Includes counselling, medication, and rehabilitation at government facilities.',
    ministry: 'Ministry of Health and Family Welfare',
    state: null,
    category: 'Healthcare',
    sourceUrl: 'https://www.nimhans.ac.in/dmhp-resources/',
    benefitType: 'non-monetary',
    benefitAmount: null,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [],
    applicationSteps: [
      { stepNumber: 1, action: 'Visit District Mental Health Programme centre', expectedOutcome: 'Counselling and treatment available' },
    ],
    documents: [D.aadhaar],
    trustScore: 88,
  },
  {
    slug: 'national-ayush',
    name: 'National AYUSH Mission',
    description: 'Promotes AYUSH systems (Ayurveda, Yoga, Naturopathy, Unani, Siddha, Homoeopathy) through co-located facilities and standalone hospitals at government centres.',
    ministry: 'Ministry of AYUSH',
    state: null,
    category: 'Healthcare',
    sourceUrl: 'https://ayush.gov.in/',
    benefitType: 'non-monetary',
    benefitAmount: null,
    deadline: null,
    applicationMode: 'offline',
    applicationUrl: null,
    eligibilityCriteria: [],
    applicationSteps: [
      { stepNumber: 1, action: 'Visit AYUSH dispensary or hospital', expectedOutcome: 'Free AYUSH treatment' },
    ],
    documents: [D.aadhaar],
    trustScore: 88,
  },
  // Education / Scholarships (12) — appended in subsequent batches
];


// ─── COMBINED SCHEMES (imported from batch files) ──────────────────────────

import { SCHEMES_BATCH_2 } from './seed-data-batch2';
import { SCHEMES_BATCH_3 } from './seed-data-batch3';
import { SCHEMES_BATCH_4 } from './seed-data-batch4';

/** Final merged scheme list — all batches combined. ~100+ schemes. */
export const ALL_SCHEMES: SeedScheme[] = [
  ...SCHEMES,
  ...SCHEMES_BATCH_2,
  ...SCHEMES_BATCH_3,
  ...SCHEMES_BATCH_4,
];

// ─── COMPATIBILITY RELATIONSHIPS ─────────────────────────────────────────────

export const RELATIONSHIPS: SeedRelationship[] = [
  { schemeSlug: 'jan-dhan', relatedSchemeSlug: 'pm-jeevan-jyoti', relationshipType: 'can_combine_with', officialRule: 'PMJJBY requires a savings account; Jan Dhan provides one for free' },
  { schemeSlug: 'jan-dhan', relatedSchemeSlug: 'pm-suraksha-bima', relationshipType: 'can_combine_with', officialRule: 'PMSBY requires a savings account; Jan Dhan provides one for free' },
  { schemeSlug: 'jan-dhan', relatedSchemeSlug: 'atal-pension', relationshipType: 'can_combine_with', officialRule: 'APY requires a savings account for auto-debit; Jan Dhan accounts qualify' },
  { schemeSlug: 'pm-jeevan-jyoti', relatedSchemeSlug: 'pm-suraksha-bima', relationshipType: 'can_combine_with', officialRule: 'Both insurance schemes can be held simultaneously' },
  { schemeSlug: 'pm-kisan', relatedSchemeSlug: 'kisan-credit-card', relationshipType: 'can_combine_with', officialRule: 'PM-KISAN beneficiaries receive a pre-approved KCC application invitation' },
  { schemeSlug: 'pm-kisan', relatedSchemeSlug: 'pm-fasal-bima', relationshipType: 'can_combine_with', officialRule: 'Crop insurance and income support are independent; both can be availed' },
  { schemeSlug: 'pm-kisan', relatedSchemeSlug: 'soil-health-card', relationshipType: 'can_combine_with', officialRule: 'PM-KISAN beneficiaries automatically eligible for Soil Health Card' },
  { schemeSlug: 'pm-kisan', relatedSchemeSlug: 'pmksy', relationshipType: 'can_combine_with', officialRule: 'PMKSY irrigation subsidy is independent of PM-KISAN income support' },
  { schemeSlug: 'kisan-credit-card', relatedSchemeSlug: 'pm-fasal-bima', relationshipType: 'can_combine_with', officialRule: 'KCC holders are auto-enrolled in PMFBY for loan-linked crops' },
  { schemeSlug: 'beti-bachao-padhao', relatedSchemeSlug: 'sukanya-samriddhi', relationshipType: 'can_combine_with', officialRule: 'Sukanya Samriddhi is the savings instrument promoted under BBBP' },
  { schemeSlug: 'beti-bachao-padhao', relatedSchemeSlug: 'up-kanya-sumangala', relationshipType: 'can_combine_with', officialRule: 'State scheme complements BBBP for UP residents' },
  { schemeSlug: 'startup-india-seed', relatedSchemeSlug: 'mudra-yojana', relationshipType: 'prerequisite_scheme', officialRule: 'Many startups secure MUDRA financing before SISFS (helpful for traction)' },
  { schemeSlug: 'startup-india-seed', relatedSchemeSlug: 'fund-of-funds-startups', relationshipType: 'can_combine_with', officialRule: 'Seed funded startups can later raise from FFS-backed AIFs' },
  { schemeSlug: 'mudra-yojana', relatedSchemeSlug: 'cgtmse', relationshipType: 'can_combine_with', officialRule: 'MUDRA loans up to Rs. 10 lakh; CGTMSE covers larger amounts' },
  { schemeSlug: 'udyam', relatedSchemeSlug: 'cgtmse', relationshipType: 'prerequisite_scheme', officialRule: 'Udyam Registration required for CGTMSE coverage' },
  { schemeSlug: 'udyam', relatedSchemeSlug: 'zed-certification', relationshipType: 'prerequisite_scheme', officialRule: 'Udyam Registration required for ZED certification' },
  { schemeSlug: 'standup-india', relatedSchemeSlug: 'mudra-yojana', relationshipType: 'cannot_combine_with', officialRule: 'Stand-Up India and MUDRA loans cannot run simultaneously for the same enterprise' },
  { schemeSlug: 'pmay-gramin', relatedSchemeSlug: 'pmay-urban', relationshipType: 'cannot_combine_with', officialRule: 'A household cannot avail both rural and urban PMAY benefits' },
  { schemeSlug: 'pmay-urban', relatedSchemeSlug: 'home-loan-interest', relationshipType: 'can_combine_with', officialRule: 'CLSS is a subset of PMAY-U interest subsidy mechanism' },
  { schemeSlug: 'national-scholarship', relatedSchemeSlug: 'aicte-pragati', relationshipType: 'can_combine_with', officialRule: 'NSP and AICTE Pragati can be availed by eligible girl students' },
  { schemeSlug: 'mid-day-meal', relatedSchemeSlug: 'samagra-shiksha', relationshipType: 'can_combine_with', officialRule: 'Both delivered through government schools; complementary' },
  { schemeSlug: 'mgnregs', relatedSchemeSlug: 'day-nrlm', relationshipType: 'can_combine_with', officialRule: 'MGNREGS workers often join NRLM SHGs for self-employment graduation' },
  { schemeSlug: 'pmkvy', relatedSchemeSlug: 'apprenticeship-training', relationshipType: 'prerequisite_scheme', officialRule: 'PMKVY-certified candidates often go on to apprenticeships' },
  { schemeSlug: 'pmkvy', relatedSchemeSlug: 'national-career-service', relationshipType: 'can_combine_with', officialRule: 'NCS hosts placement opportunities for PMKVY-certified candidates' },
  { schemeSlug: 'ayushman-bharat', relatedSchemeSlug: 'rashtriya-swasthya', relationshipType: 'cannot_combine_with', officialRule: 'PM-JAY succeeds and replaces RSBY in covered states' },
  { schemeSlug: 'ayushman-bharat', relatedSchemeSlug: 'janani-suraksha', relationshipType: 'can_combine_with', officialRule: 'JSY for delivery assistance; PM-JAY covers complications' },
  { schemeSlug: 'ayushman-bharat', relatedSchemeSlug: 'national-health-mission', relationshipType: 'can_combine_with', officialRule: 'PM-JAY for hospitalization; NHM for primary care' },
  { schemeSlug: 'mahila-samman', relatedSchemeSlug: 'sukanya-samriddhi', relationshipType: 'can_combine_with', officialRule: 'Both small savings; can be held simultaneously' },
  { schemeSlug: 'pm-shram-yogi', relatedSchemeSlug: 'atal-pension', relationshipType: 'cannot_combine_with', officialRule: 'PM-SYM and APY are mutually exclusive — choose one' },
  { schemeSlug: 'epfo-uan', relatedSchemeSlug: 'national-pension-system', relationshipType: 'can_combine_with', officialRule: 'EPF mandatory for organized workers; NPS voluntary supplement' },
];
