import bcrypt from "bcrypt";
import { Request } from "express";
import httpStatus from 'http-status';
import { JwtPayload, Secret } from "jsonwebtoken";
import { configs } from "../../configs";
import { AppError } from "../../utils/app_error";
import uploadCloud from "../../utils/cloudinary";
import { jwtHelpers } from "../../utils/JWT";
import sendMail from "../../utils/mail_sender";
import { OTPMaker } from "../../utils/otpMaker";
import { mentor_model } from "../mentor/mentor.schema";
import { ProfessionalModel } from "../professional/professional.schema";
import { professional_profile_type_const_model, student_profile_type_const_model } from "../profile_type_const/profile_type_const.schema";
import { Student_Model } from "../student/student.schema";
import { isAccountExist } from './../../utils/isAccountExist';
import { TAccount, TLoginPayload, TRegisterPayload, TStatus } from "./auth.interface";
import { Account_Model } from "./auth.schema";
import mongoose from "mongoose";
import { getNormalizedContentScopeForAccount } from "../../utils/normalizeProfileType";


const buildVerificationUrl = (email: string) => {
  const secret = configs.jwt.verified_token as Secret;
  if (!secret) {
    throw new AppError("VERIFIED_TOKEN is not configured", httpStatus.INTERNAL_SERVER_ERROR);
  }
  if (!configs.jwt.front_end_url) {
    throw new AppError("FRONT_END_URL is not configured", httpStatus.INTERNAL_SERVER_ERROR);
  }

  const token = jwtHelpers.generateToken({ email }, secret, "1d");
  return `${configs.jwt.front_end_url}/verify-email?token=${encodeURIComponent(token)}`;
};

const sendVerificationEmail = async (email: string) => {
  const verifyUrl = buildVerificationUrl(email);

  const templateId = configs.email.sg_verify_template_id;
  const usedTemplateId = templateId || "d-46ca03370b2e45a29a139b4881c23a68";

  // Dynamic template variables (adjust names to match your template).
  const dynamicTemplateData = {
    verify_url: verifyUrl,
    email,
  };

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; line-height: 1.5; color:#111827;">
      <h2 style="margin:0 0 12px 0;">Verify your email</h2>
      <p style="margin:0 0 12px 0;">Please verify your email to continue.</p>
      <p style="margin:0 0 18px 0;">
        <a href="${verifyUrl}" style="display:inline-block;background:#0D71CF;color:#ffffff;text-decoration:none;padding:10px 14px;border-radius:8px;">
          Verify email
        </a>
      </p>
      <p style="margin:0 0 6px 0;">If the button doesn’t work, copy and paste this link:</p>
      <p style="margin:0; word-break:break-all;">${verifyUrl}</p>
    </div>
  `;

  const result = await sendMail({
    to: email,
    subject: "Verify your email",
    textBody: `Verify your email: ${verifyUrl}`,
    htmlBody,
    templateId: usedTemplateId,
    dynamicTemplateData,
  });

  // If email sending is skipped (SMTP not configured + no SendGrid key),
  // still surface the link in logs for dev.
  if ((result as any)?.ok === false) {
    // eslint-disable-next-line no-console
    console.log("Verification link:", verifyUrl);
  }
};

const check_email_from_db = async (email: string) => {
  if (!email) throw new AppError("Email is required", httpStatus.BAD_REQUEST);
  const exists = await Account_Model.exists({ email });
  return { exists: Boolean(exists) };
};

const resolveProfileTypeNameFromId = async (profileTypeId: string) => {
  if (!profileTypeId) return null;
  if (!mongoose.Types.ObjectId.isValid(profileTypeId)) return null;

  const [studentType, professionalType] = await Promise.all([
    student_profile_type_const_model.findById(profileTypeId).lean(),
    professional_profile_type_const_model.findById(profileTypeId).lean(),
  ]);

  if (studentType?.typeName) return { category: "STUDENT" as const, typeName: String(studentType.typeName) };
  if (professionalType?.typeName) return { category: "PROFESSIONAL" as const, typeName: String(professionalType.typeName) };
  return null;
};

/**
 * Backward compatible fix:
 * Some users were registered with profile type _id stored in studentType/professionName.
 * Content filtering expects profileType to be the typeName string (e.g. "Neurology").
 * This normalizes the stored value to typeName once, on login.
 */
const normalizeProfileTypeForAccount = async (accountId: string, role: string) => {
  if (!accountId) return;

  if (role === "STUDENT") {
    const student = await Student_Model.findOne({ accountId }).select("studentType").lean();
    const current = student?.studentType;
    if (typeof current === "string") {
      const resolved = await resolveProfileTypeNameFromId(current);
      if (resolved?.category === "STUDENT") {
        await Student_Model.updateOne({ accountId }, { $set: { studentType: resolved.typeName } });
      }
    }
    return;
  }

  if (role === "PROFESSIONAL") {
    const professional = await ProfessionalModel.findOne({ accountId }).select("professionName").lean();
    const current = professional?.professionName;
    if (typeof current === "string") {
      const resolved = await resolveProfileTypeNameFromId(current);
      if (resolved?.category === "PROFESSIONAL") {
        await ProfessionalModel.updateOne({ accountId }, { $set: { professionName: resolved.typeName } });
      }
    }
  }
};

// register user
const register_user_into_db = async (payload: TRegisterPayload) => {
  const isExistAccount = await Account_Model.findOne({ email: payload?.email });
  if (isExistAccount) {
    throw new AppError("Account already exist!!", httpStatus.BAD_REQUEST);
  }
  // Generate 6-digit OTP
  // const otp = OTPMaker();
  // const otpDigits = otp.split("");
  const hashedPassword: string = bcrypt.hashSync(payload.password, 10);

  const resolvedProfileType = await resolveProfileTypeNameFromId(payload.profileTypeId);
  if (!resolvedProfileType) {
    throw new AppError("Invalid profile type", httpStatus.BAD_REQUEST);
  }

  const accountRegistrationPayload: Partial<TAccount> = {
    email: payload?.email,
    isVerified: false,
    role: resolvedProfileType.category === "STUDENT" ? "STUDENT" : "PROFESSIONAL",
    profile_type: resolvedProfileType.category === "STUDENT" ? "student_profile" : "professional_profile",
    authType: "CUSTOM",
    password: hashedPassword,
  };

  const createdAccount = await Account_Model.create(accountRegistrationPayload);

  const createdProfile = resolvedProfileType.category === "STUDENT"
    ? await Student_Model.create({
      accountId: createdAccount._id,
      firstName: payload.firstName,
      lastName: payload.lastName,
      studentType: resolvedProfileType.typeName,
      phone: payload.phone,
    } as any)
    : await ProfessionalModel.create({
      accountId: createdAccount._id,
      firstName: payload.firstName,
      lastName: payload.lastName,
      phone: payload.phone,
      professionName: resolvedProfileType.typeName,
    } as any);

  await Account_Model.findByIdAndUpdate(createdAccount._id, { profile_id: createdProfile._id });

  await sendVerificationEmail(payload.email);

  // Email template (OTP email flow temporarily disabled)
  /*
  const emailTemp = `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f6f7fb; margin:0; padding:0;">
    <tr>
      <td align="center" style="padding:80px 5px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
          style="max-width:640px; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 16px rgba(17,24,39,0.08); padding: 40px;">

          <tr>
            <td align="left" style="padding:0 24px 4px 24px;">
              <h1 style="margin:0; font-size:24px; line-height:32px; color:#111827; font-weight:800; font-family:Arial, sans-serif;">
                Hi Dear,
              </h1>
            </td>
          </tr>

          <tr>
            <td align="left" style="padding:8px 24px 0 24px;">
              <p style="margin:0; font-size:15px; line-height:24px; color:#374151; font-family:Arial, sans-serif;">
                Here is your One Time Password (OTP). Please enter this code to verify your email address for MSH.
              </p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:20px 24px 8px 24px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
                <tr>
                  ${otpDigits
      .map(
        (digit) => `
                    <td align="center" valign="middle"
                      style="background:#f5f3ff; border-radius:12px; width:56px; height:56px;">
                      <div style="font-size:22px; line-height:56px; color:#111827; font-weight:700; font-family:Arial, sans-serif; text-align:center;">
                        ${digit}
                      </div>
                    </td>
                    <td style="width:12px;">&nbsp;</td>
                  `
      )
      .join("")}
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td align="left" style="padding:8px 24px 4px 24px;">
              <p style="margin:0; font-size:14px; line-height:22px; color:#6b7280; font-family:Arial, sans-serif;">
                OTP will expire in <span style="font-weight:700; color:#111827;">5 minutes</span>.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  `;
  */

  // OTP email sending is temporarily disabled.
  // await sendMail({
  //   to: payload?.email,
  //   textBody: `Your OTP is ${otp}`,
  //   subject: "Verify your email",
  //   htmlBody: emailTemp,
  // });
  return "Account created successfully"
};

const verified_account_into_db = async (payload: { email: string, otp: string }) => {
  const isAccountExists = await isAccountExist(payload.email)
  // OTP verification is temporarily disabled.
  // if (isAccountExists.isVerified) {
  //   throw new AppError('Account already verified', httpStatus.BAD_REQUEST);
  // }
  // if (isAccountExists.lastOTP !== payload.otp) {
  //   throw new AppError('Invalid OTP', httpStatus.UNAUTHORIZED);
  // }

  await Account_Model.findOneAndUpdate({ email: payload.email }, {
    isVerified: true,
    lastOTP: "",
  });

  const accessToken = jwtHelpers.generateToken(
    {
      email: isAccountExists?.email,
      role: isAccountExists?.role,
      accountId: isAccountExists._id
    },
    configs.jwt.access_token as Secret,
    configs.jwt.access_expires as string,
  );

  return {
    accessToken,
    role: isAccountExists?.role
  };
}

const get_new_verification_otp_from_db = async (email: string) => {
  await isAccountExist(email)
  const otp = OTPMaker();
  await Account_Model.findOneAndUpdate({ email }, { lastOTP: otp })
  const otpDigits = otp.split("");
  const emailTemp = `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f6f7fb; margin:0; padding:0;">
    <tr>
      <td align="center" style="padding:80px 5px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
          style="max-width:640px; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 16px rgba(17,24,39,0.08); padding: 40px;">

          <tr>
            <td align="left" style="padding:0 24px 4px 24px;">
              <h1 style="margin:0; font-size:24px; line-height:32px; color:#111827; font-weight:800; font-family:Arial, sans-serif;">
                Hi Dear,
              </h1>
            </td>
          </tr>

          <tr>
            <td align="left" style="padding:8px 24px 0 24px;">
              <p style="margin:0; font-size:15px; line-height:24px; color:#374151; font-family:Arial, sans-serif;">
                Here is your another One Time Password (OTP). Please enter this code to verify your email address for MSH.
              </p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:20px 24px 8px 24px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
                <tr>
                  ${otpDigits
      .map(
        (digit) => `
                    <td align="center" valign="middle"
                      style="background:#f5f3ff; border-radius:12px; width:56px; height:56px;">
                      <div style="font-size:22px; line-height:56px; color:#111827; font-weight:700; font-family:Arial, sans-serif; text-align:center;">
                        ${digit}
                      </div>
                    </td>
                    <td style="width:12px;">&nbsp;</td>
                  `
      )
      .join("")}
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td align="left" style="padding:8px 24px 4px 24px;">
              <p style="margin:0; font-size:14px; line-height:22px; color:#6b7280; font-family:Arial, sans-serif;">
                OTP will expire in <span style="font-weight:700; color:#111827;">5 minutes</span>.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  `;

  await sendMail({
    to: email,
    subject: "New OTP for account verification",
    textBody: `New OTP is sent to your email on ${new Date().toLocaleDateString()}`,
    htmlBody: emailTemp
  })

  return null
}

const login_user_from_db = async (payload: TLoginPayload) => {
  // check account info 
  const isExistAccount = await isAccountExist(payload?.email)
  if (!isExistAccount.isVerified) {
    throw new AppError(
      `Email is not verified. Please check ${payload?.email} for a verification link.`,
      httpStatus.FORBIDDEN
    );
  }
  if (isExistAccount.accountStatus === "INACTIVE") {
    throw new AppError('Account is not active, contact us on support', httpStatus.UNAUTHORIZED);
  }
  if (isExistAccount.accountStatus === "SUSPENDED") {
    throw new AppError('Account is suspended, contact us on support', httpStatus.UNAUTHORIZED);
  }

  await normalizeProfileTypeForAccount(String(isExistAccount._id), String(isExistAccount.role));
  const isPasswordMatch = await bcrypt.compare(
    payload.password,
    isExistAccount.password,
  );

  if (!isPasswordMatch) {
    throw new AppError('Invalid password', httpStatus.UNAUTHORIZED);
  }
  const accessToken = jwtHelpers.generateToken(
    {
      email: isExistAccount.email,
      role: isExistAccount.role,
      accountId: isExistAccount._id
    },
    configs.jwt.access_token as Secret,
    configs.jwt.access_expires as string,
  );

  const refreshToken = jwtHelpers.generateToken(
    {
      email: isExistAccount.email,
      role: isExistAccount.role,
      accountId: isExistAccount._id
    },
    configs.jwt.refresh_token as Secret,
    configs.jwt.refresh_expires as string,
  );
  return {
    accessToken: accessToken,
    refreshToken: refreshToken,
    role: isExistAccount.role
  };

}

const verify_email_into_db = async (token: string) => {
  const secret = configs.jwt.verified_token as Secret;
  if (!secret) throw new AppError("VERIFIED_TOKEN is not configured", httpStatus.INTERNAL_SERVER_ERROR);

  let decoded: any;
  try {
    decoded = jwtHelpers.verifyToken(token, secret);
  } catch {
    throw new AppError("Invalid or expired verification token", httpStatus.BAD_REQUEST);
  }

  const email = decoded?.email;
  if (!email) throw new AppError("Invalid verification token", httpStatus.BAD_REQUEST);

  const account = await Account_Model.findOne({ email });
  if (!account) throw new AppError("Account not found", httpStatus.NOT_FOUND);

  if (account.isVerified) return { verified: true };

  await Account_Model.updateOne({ email }, { $set: { isVerified: true, lastOTP: "" } });

  // Welcome email to the user after verification (SendGrid template if configured).
  if (configs.email.sg_welcome_template_id) {
    try {
      await sendMail({
        to: email,
        subject: "Welcome to Zyura",
        textBody: `Welcome to Zyura, ${email}!`,
        htmlBody: `<p>Welcome to Zyura, <b>${email}</b>!</p>`,
        templateId: configs.email.sg_welcome_template_id,
        dynamicTemplateData: {
          email,
        },
      });
    } catch {
      // Don't block verification if welcome email fails.
    }
  }

  // Notify Zyura team inbox on successful verification (optional).
  if (configs.email.zyura_notify_email) {
    try {
      await sendMail({
        to: configs.email.zyura_notify_email,
        subject: "New user verified email",
        textBody: `A user verified their email: ${email}`,
        htmlBody: `<p>A user verified their email: <b>${email}</b></p>`,
      });
    } catch {
      // Don't block verification if notification email fails.
    }
  }
  return { verified: true };
};

const resend_verification_email_from_db = async (email: string) => {
  const account = await Account_Model.findOne({ email });
  if (!account) throw new AppError("Account not found", httpStatus.NOT_FOUND);
  if (account.isVerified) return { sent: false, reason: "already_verified" };

  await sendVerificationEmail(email);
  return { sent: true };
};

const update_student_profile_into_db = async (req: Request) => {
  const user = req?.user;
  const body = req?.body;
  const isValidAccount = await isAccountExist(user?.email as string);


  // upload image if exist
  if (req?.file) {
    const cloudRes = await uploadCloud(req?.file)
    body.profile_photo = cloudRes?.secure_url
  }

  let updatedResult;

  // update profile conditionally
  if (body.role == "STUDENT") {
    const studentPayload = {
      ...body?.student,
      bio: body?.bio,
      profile_photo: body?.profile_photo,
      accountId: isValidAccount._id
    }
    updatedResult = await Student_Model.create(studentPayload)
  }

  if (body.role == "MENTOR") {
    const mentorPayload = {
      ...body?.mentor,
      profile_photo: body?.profile_photo,
      bio: body?.bio,
      accountId: isValidAccount._id
    }
    updatedResult = await mentor_model.create(mentorPayload)
  }
  if (body.role == "PROFESSIONAL") {
    const professionalPayload = {
      ...body?.professional,
      profile_photo: body?.profile_photo,
      bio: body?.bio,
      accountId: isValidAccount._id
    }
    updatedResult = await ProfessionalModel.create(professionalPayload)
  }
  // change profile type
  // "admin_profile" | "student_profile" | "mentor_profile" | "professional_profile";
  const profileType = (body.role == "STUDENT" ? "student_profile" :
    body.role == "MENTOR" ? "mentor_profile" :
      body.role == "PROFESSIONAL" ? "professional_profile" : "")

  await Account_Model.findOneAndUpdate(
    { email: isValidAccount.email },
    { profile_id: updatedResult?._id, role: body.role, profile_type: profileType }
  )
  return updatedResult
};


const get_my_profile_from_db = async (email: string) => {
  const isExistAccount = await Account_Model.findOne({ email })
    .populate('profile_id')
    .lean();

  if (!isExistAccount) {
    throw new AppError("Account not found", httpStatus.NOT_FOUND);
  }

  // 🔥 CRITICAL FIX: Normalize the profession/student type
  const { profileType } = await getNormalizedContentScopeForAccount(
    String(isExistAccount._id),
    String(isExistAccount.role)
  );

  // Build the profile response dynamically
  const profileData = { ...isExistAccount.profile_id } as Record<string, any>;
  
  if (isExistAccount.role === "PROFESSIONAL" && profileType) {
    profileData.professionName = profileType;
  } else if (isExistAccount.role === "STUDENT" && profileType) {
    profileData.studentType = profileType;
  }

  return {
    account: {
      ...isExistAccount,
      password: "",
      profile_id: (profileData as any)?._id,
    },
    profile: profileData,
  };
};

const refresh_token_from_db = async (token: string) => {
  let decodedData;
  try {
    decodedData = jwtHelpers.verifyToken(
      token,
      configs.jwt.refresh_token as Secret,
    );
  } catch (err) {
    throw new Error('You are not authorized!');
  }

  const userData = await isAccountExist(decodedData.email)

  const accessToken = jwtHelpers.generateToken(
    {
      email: userData!.email,
      role: userData!.role,
      accountId: userData!._id,
    },
    configs.jwt.access_token as Secret,
    configs.jwt.access_expires as string,
  );

  return accessToken;
};

const change_password_from_db = async (
  user: JwtPayload,
  payload: {
    oldPassword: string;
    newPassword: string;
  },
) => {
  const isExistAccount = await isAccountExist(user.email)
  const isCorrectPassword: boolean = await bcrypt.compare(
    payload.oldPassword,
    isExistAccount.password,
  );

  if (!isCorrectPassword) {
    throw new AppError('Old password is incorrect', httpStatus.UNAUTHORIZED);
  }

  const hashedPassword: string = await bcrypt.hash(payload.newPassword, 10);
  await Account_Model.findOneAndUpdate({ email: isExistAccount.email }, {
    password: hashedPassword,
    lastPasswordChange: Date()
  })
  return 'Password changed successful.';
};

const forget_password_from_db = async (email: string) => {
  const isAccountExists = await isAccountExist(email)
  const otp = OTPMaker()
  await Account_Model.findOneAndUpdate({ email: isAccountExists.email }, { lastOTP: otp })
  const otpDigits = otp.split("");
  const emailTemp = `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f6f7fb; margin:0; padding:0;">
    <tr>
      <td align="center" style="padding:80px 5px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
          style="max-width:640px; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 16px rgba(17,24,39,0.08); padding: 40px;">

          <tr>
            <td align="left" style="padding:0 24px 4px 24px;">
              <h1 style="margin:0; font-size:24px; line-height:32px; color:#111827; font-weight:800; font-family:Arial, sans-serif;">
                Hi,
              </h1>
            </td>
          </tr>

          <tr>
            <td align="left" style="padding:8px 24px 0 24px;">
              <p style="margin:0; font-size:15px; line-height:24px; color:#374151; font-family:Arial, sans-serif;">
                Here is your reset One Time Password (OTP). Please enter this code to verify your email address for MSH.
              </p>
            </td>
          </tr>

          <tr>
            <td align="center" style="padding:20px 24px 8px 24px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
                <tr>
                  ${otpDigits
      .map(
        (digit) => `
                    <td align="center" valign="middle"
                      style="background:#f5f3ff; border-radius:12px; width:56px; height:56px;">
                      <div style="font-size:22px; line-height:56px; color:#111827; font-weight:700; font-family:Arial, sans-serif; text-align:center;">
                        ${digit}
                      </div>
                    </td>
                    <td style="width:12px;">&nbsp;</td>
                  `
      )
      .join("")}
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td align="left" style="padding:8px 24px 4px 24px;">
              <p style="margin:0; font-size:14px; line-height:22px; color:#6b7280; font-family:Arial, sans-serif;">
                OTP will expire in <span style="font-weight:700; color:#111827;">5 minutes</span>.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
  `;

  await sendMail({
    to: email,
    subject: "Password reset successful!",
    textBody: "Your password is successfully reset.",
    htmlBody: emailTemp
  });

  return 'Check your email for reset link';
};

const reset_password_into_db = async (
  otp: string,
  email: string,
  newPassword: string,
) => {

  const isAccountExists = await isAccountExist(email)
  if (isAccountExists.email !== email) {
    throw new AppError('Invalid email', httpStatus.UNAUTHORIZED);
  }
  if (isAccountExists.lastOTP !== otp) {
    throw new AppError('Invalid OTP', httpStatus.UNAUTHORIZED);
  }
  const hashedPassword: string = await bcrypt.hash(newPassword, 10);

  await Account_Model.findOneAndUpdate({ email: isAccountExists.email }, {
    password: hashedPassword,
  })
  return 'Password reset successfully!';
};

const change_profile_status_from_db = async (
  status: TStatus,
  email: string,
) => {
  await Account_Model.findOneAndUpdate({ email: email }, {
    accountStatus: status,
  })
  return null;
};

const sign_in_with_google_and_save_in_db = async (payload: any) => {
  let account = await Account_Model.findOneAndUpdate(
    { email: payload.email },
    {
      $setOnInsert: {
        email: payload.email,
        authType: "GOOGLE",
        accountStatus: "ACTIVE",
        isVerified: true,
        role: "STUDENT",
        profile_type: "student_profile",
      },
    },
    { upsert: true, new: true }
  ).lean();

  if (!account.profile_id) {
    const profilePromise = Student_Model.create({
      firstName: payload.name,
      profile_photo: payload.photo,
      accountId: account._id,
    });

    const [profile] = await Promise.all([profilePromise]);

    // Update account with profile_id
    await Account_Model.findByIdAndUpdate(account._id, { profile_id: profile._id });

    account.profile_id = profile._id; // update local object
  }

  // Generate tokens
  const tokenPayload = { email: account.email, role: account.role, accountId: account._id };
  const [accessToken, refreshToken] = await Promise.all([
    jwtHelpers.generateToken(tokenPayload, configs.jwt.access_token as Secret, configs.jwt.access_expires as string),
    jwtHelpers.generateToken(tokenPayload, configs.jwt.refresh_token as Secret, configs.jwt.refresh_expires as string),
  ]);

  return {
    accessToken,
    refreshToken,
    role: account.role,
  };
};


const update_profiles_from_db = async (req: Request) => {
  const { role, email } = req?.user as JwtPayload;
  const payload = req?.body;
  const isExistAccount = await isAccountExist(email);

  if (req?.file) {
    const cloudRes = await uploadCloud(req?.file)
    payload.profile_photo = cloudRes?.secure_url
  }

  // update profile
  let result;
  if (role == "STUDENT") {
    result = await Student_Model.findOneAndUpdate({ accountId: isExistAccount._id }, payload, { new: true, upsert: true });
  }
  if (role == "MENTOR") {
    result = await mentor_model.findOneAndUpdate({ accountId: isExistAccount._id }, payload, { new: true, upsert: true });
  }
  if (role == "PROFESSIONAL") {
    result = await ProfessionalModel.findOneAndUpdate({ accountId: isExistAccount._id }, payload, { new: true, upsert: true });
  }

  return result;
}

export const auth_services = {
  check_email_from_db,
  register_user_into_db,
  login_user_from_db,
  get_my_profile_from_db,
  refresh_token_from_db,
  change_password_from_db,
  forget_password_from_db,
  reset_password_into_db,
  verified_account_into_db,
  get_new_verification_otp_from_db,
  verify_email_into_db,
  resend_verification_email_from_db,
  update_student_profile_into_db,
  change_profile_status_from_db,
  sign_in_with_google_and_save_in_db,
  update_profiles_from_db
}  