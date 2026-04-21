import nodemailer from "nodemailer";
import sgMail from "@sendgrid/mail";

import { configs } from "../configs";

type TMailContent = {
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  name?: string;
  templateId?: string;
  dynamicTemplateData?: Record<string, any>;
};

type SendMailResult =
  | { ok: true; info: unknown }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; error: unknown };

const getTransporter = () => {
  const host = configs.mailgun.smtp_host;
  const portStr = configs.mailgun.smtp_port;
  const user = configs.mailgun.smtp_user;
  const pass = configs.mailgun.smtp_pass;

  const port = portStr ? Number(portStr) : NaN;

  if (!host || !Number.isFinite(port) || !user || !pass) return null;

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
};

const sendMail = async (payload: TMailContent): Promise<SendMailResult> => {
  // Prefer SendGrid Dynamic Templates when configured.
  if (configs.email.sg_api_key) {
    if (!configs.email.sg_from) {
      throw new Error("SENDGRID_FROM is required when using SendGrid");
    }
    sgMail.setApiKey(configs.email.sg_api_key);

    try {
      if (payload.templateId) {
        await sgMail.send({
          to: payload.to,
          from: configs.email.sg_from,
          templateId: payload.templateId,
          dynamicTemplateData: payload.dynamicTemplateData || {},
        });
      } else {
        await sgMail.send({
          to: payload.to,
          from: configs.email.sg_from,
          subject: payload.subject,
          text: payload.textBody,
          html: payload.htmlBody,
        });
      }
      return { ok: true, info: { provider: "sendgrid" } };
    } catch (error) {
      console.error("SendGrid mail send failed:", error);
      if (configs.env !== "production") {
        return { ok: false, skipped: false, error };
      }
      throw error;
    }
  }

  const from = configs.mailgun.from;
  const transporter = getTransporter();

  // Local/dev fallback: don't fail flows if SMTP isn't configured.
  if (!from || !transporter) {
    console.warn(
      "SMTP not configured; skipping email send.",
      JSON.stringify({ to: payload.to, subject: payload.subject }),
    );
    return {
      ok: false,
      skipped: true,
      reason: "SMTP not configured",
    };
  }

  try {
    const info = await transporter.sendMail({
      from,
      to: payload.to,
      subject: payload.subject,
      text: payload.textBody,
      html: payload.htmlBody,
    });

    return { ok: true, info };
  } catch (error) {
    console.error("Mail send failed:", error);
    // Don't break local/dev if SMTP server is unreachable.
    if (configs.env !== "production") {
      return { ok: false, skipped: false, error };
    }
    throw error;
  }
};

export default sendMail;
