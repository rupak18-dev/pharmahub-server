export function ok(res, data = null, message = null, meta = null) {
  return res.status(200).json({
    success: true,
    message,
    data,
    meta,
  });
}

export function created(res, data = null, message = "Created") {
  return res.status(201).json({
    success: true,
    message,
    data,
  });
}

export function noContent(res) {
  return res.status(204).end();
}
