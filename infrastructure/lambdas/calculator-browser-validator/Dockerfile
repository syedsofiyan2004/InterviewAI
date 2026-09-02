FROM public.ecr.aws/lambda/nodejs:22

WORKDIR ${LAMBDA_TASK_ROOT}
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY index.mjs ./

CMD ["index.handler"]
