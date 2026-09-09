const REQUIRED_VARS = [
  "MONGO_URI",
  "JWT_SECRET",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "EMAIL_USER",
  "EMAIL_PASS",
];

// Fails fast and loudly at startup instead of letting a missing var surface
// as a confusing error mid-request (or a silent `undefined` bug) later.
export const validateEnv = () => {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  const optionalButRecommended = [
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "GEMINI_API_KEY",
    "FIREBASE_SERVICE_ACCOUNT_KEY",
    "REDIS_URL",
  ];
  const missingOptional = optionalButRecommended.filter((key) => !process.env[key]);
  if (missingOptional.length > 0) {
    console.warn(
      `Warning: optional environment variables not set (related features will be degraded/disabled): ${missingOptional.join(", ")}`
    );
  }
};

export default validateEnv;
