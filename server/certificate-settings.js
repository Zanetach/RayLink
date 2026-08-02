export function normalizeCertificateEmail(
  value,
  { errorCode = "INVALID_CERTIFICATE_EMAIL" } = {}
) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,63}$/.test(email)) {
    const error = new Error("请输入有效的证书通知邮箱");
    error.code = errorCode;
    error.statusCode = 422;
    throw error;
  }
  return email;
}
