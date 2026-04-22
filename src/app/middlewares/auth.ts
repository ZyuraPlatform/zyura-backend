import { NextFunction, Request, Response } from 'express';
import { configs } from '../configs';
import { Account_Model } from '../modules/auth/auth.schema';
import { AppError } from '../utils/app_error';
import { jwtHelpers, JwtPayloadType } from '../utils/JWT';
import { debugLog } from '../utils/debugLog';


type Role = "ADMIN" | "STUDENT" | "MENTOR" | "PROFESSIONAL"


const auth = (...roles: Role[]) => {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const rawAuthHeader = req.headers.authorization;
            const tokenFromHeader =
                typeof rawAuthHeader === 'string' && rawAuthHeader.toLowerCase().startsWith('bearer ')
                    ? rawAuthHeader.slice(7).trim()
                    : rawAuthHeader;
            const token = tokenFromHeader || req.cookies.accessToken;
            // #region agent log
            debugLog({
                runId: 'pre-fix',
                hypothesisId: 'H5',
                location: 'auth.ts:token_read',
                message: 'Auth middleware token read',
                data: {
                    hasAuthHeader: Boolean(rawAuthHeader),
                    authHeaderStartsWithBearer: typeof rawAuthHeader === 'string' ? rawAuthHeader.toLowerCase().startsWith('bearer ') : false,
                    authHeaderLen: typeof rawAuthHeader === 'string' ? rawAuthHeader.length : 0,
                    extractedTokenLen: typeof tokenFromHeader === 'string' ? tokenFromHeader.length : 0,
                    hasCookieToken: Boolean(req.cookies?.accessToken),
                    cookieTokenLen: typeof req.cookies?.accessToken === 'string' ? req.cookies.accessToken.length : 0,
                    rolesRequired: roles,
                    path: req.originalUrl,
                },
            });
            // #endregion
            if (!token) {
                throw new AppError('You are not authorize!!', 401);
            }
            const verifiedUser = jwtHelpers.verifyToken(
                token,
                configs.jwt.access_token as string,
            );
            if (!roles.length || !roles.includes(verifiedUser.role)) {
                throw new AppError('You are not authorize!!', 401);
            }
            // check user
            const isUserExist = await Account_Model.findOne({ email: verifiedUser?.email }).lean()
            if (!isUserExist) {
                throw new AppError("Account not found !", 404)
            }
            if (isUserExist?.accountStatus == "INACTIVE") {
                throw new AppError("This Account is temporary blocked, contact us on support !", 401)
            }
            if (isUserExist?.accountStatus == "SUSPENDED") {
                throw new AppError("This Account is suspend, contact us on support !", 401)
            }
            if (isUserExist?.isDeleted) {
                throw new AppError("This account is deleted", 401)
            }
            // isVerified check temporarily disabled
            // if (!isUserExist?.isVerified) {
            //     throw new AppError("This account is not verified ", 401)
            // }
            verifiedUser.profileType = isUserExist?.profile_type
            // Ensure downstream services always have accountId even if a token is missing it.
            verifiedUser.accountId = verifiedUser.accountId || String(isUserExist._id)
            req.user = verifiedUser as JwtPayloadType;
            next();
        } catch (err) {
            next(err);
        }
    };
};

export default auth;