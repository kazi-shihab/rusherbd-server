const jwt = require("jsonwebtoken");

function verifyAdminToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Admin token required",
      });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.tokenType !== "admin" || !decoded.adminId) {
      return res.status(403).json({
        success: false,
        message: "Invalid admin token",
      });
    }

    req.admin = {
      id: decoded.adminId,
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired admin token",
    });
  }
}

module.exports = verifyAdminToken;
