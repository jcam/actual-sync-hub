import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppContext } from "./app-context.js";

const {
  actualServiceMock,
  appServiceMock,
  authServiceMock,
  databaseMock,
  homeValuesServiceMock,
  plaidServiceMock,
  providerSettingsServiceMock,
  simplefinServiceMock,
  stripeServiceMock,
  tellerServiceMock,
  createAppServiceMock,
  createAuthServiceMock,
  createHomeValuesServiceMock,
  createProviderSettingsServiceMock,
} = vi.hoisted(() => ({
  actualServiceMock: {
    name: "actual-service"
  },
  appServiceMock: {
    name: "app-service"
  },
  authServiceMock: {
    name: "auth-service"
  },
  databaseMock: {
    name: "prisma"
  },
  homeValuesServiceMock: {
    name: "home-values-service"
  },
  plaidServiceMock: {
    name: "plaid-service"
  },
  providerSettingsServiceMock: {
    name: "provider-settings-service"
  },
  simplefinServiceMock: {
    name: "simplefin-service"
  },
  stripeServiceMock: {
    name: "stripe-service"
  },
  tellerServiceMock: {
    name: "teller-service"
  },
  createAppServiceMock: vi.fn(),
  createAuthServiceMock: vi.fn(),
  createHomeValuesServiceMock: vi.fn(),
  createProviderSettingsServiceMock: vi.fn(),
}));

vi.mock("./db.js", () => ({
  prisma: databaseMock
}));

vi.mock("./services/actual-service.js", () => ({
  actualService: actualServiceMock
}));

vi.mock("./services/app-service.js", () => ({
  createAppService: createAppServiceMock
}));

vi.mock("./services/auth.js", () => ({
  createAuthService: createAuthServiceMock
}));

vi.mock("./services/home-values-service.js", () => ({
  createHomeValuesService: createHomeValuesServiceMock
}));

vi.mock("./services/plaid-service.js", () => ({
  plaidService: plaidServiceMock
}));

vi.mock("./services/provider-settings-service.js", () => ({
  createProviderSettingsService: createProviderSettingsServiceMock
}));

vi.mock("./services/simplefin-service.js", () => ({
  simplefinService: simplefinServiceMock
}));

vi.mock("./services/stripe-service.js", () => ({
  stripeService: stripeServiceMock
}));

vi.mock("./services/teller-service.js", () => ({
  tellerService: tellerServiceMock
}));

describe("createAppContext", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("builds the default context from the shared service factories and singletons", () => {
    createProviderSettingsServiceMock.mockReturnValue(providerSettingsServiceMock);
    createHomeValuesServiceMock.mockReturnValue(homeValuesServiceMock);
    createAuthServiceMock.mockReturnValue(authServiceMock);
    createAppServiceMock.mockReturnValue(appServiceMock);

    const context = createAppContext();

    expect(createProviderSettingsServiceMock).toHaveBeenCalledWith({
      prisma: databaseMock
    });
    expect(createHomeValuesServiceMock).toHaveBeenCalledWith({
      prisma: databaseMock,
      providerSettings: providerSettingsServiceMock
    });
    expect(createAuthServiceMock).toHaveBeenCalledWith({
      prisma: databaseMock
    });
    expect(createAppServiceMock).toHaveBeenCalledWith({
      prisma: databaseMock,
      actualService: actualServiceMock,
      homeValuesService: homeValuesServiceMock,
      plaidService: plaidServiceMock,
      providerSettingsService: providerSettingsServiceMock,
      simplefinService: simplefinServiceMock,
      stripeService: stripeServiceMock,
      tellerService: tellerServiceMock
    });

    expect(context).toEqual({
      prisma: databaseMock,
      actualService: actualServiceMock,
      homeValuesService: homeValuesServiceMock,
      plaidService: plaidServiceMock,
      providerSettingsService: providerSettingsServiceMock,
      simplefinService: simplefinServiceMock,
      stripeService: stripeServiceMock,
      tellerService: tellerServiceMock,
      authService: authServiceMock,
      appService: appServiceMock
    });
  });

  it("uses explicit overrides instead of constructing replacement services", () => {
    const overrides = {
      prisma: {
        name: "override-prisma"
      },
      actualService: {
        name: "override-actual"
      },
      homeValuesService: {
        name: "override-home-values"
      },
      providerSettingsService: {
        name: "override-provider-settings"
      },
      plaidService: {
        name: "override-plaid"
      },
      simplefinService: {
        name: "override-simplefin"
      },
      stripeService: {
        name: "override-stripe"
      },
      tellerService: {
        name: "override-teller"
      },
      authService: {
        name: "override-auth"
      },
      appService: {
        name: "override-app"
      },
      scheduler: {
        requestWakeup: vi.fn(),
        requestWakeupForAccounts: vi.fn()
      }
    };

    const context = createAppContext(overrides as never);

    expect(createProviderSettingsServiceMock).not.toHaveBeenCalled();
    expect(createHomeValuesServiceMock).not.toHaveBeenCalled();
    expect(createAuthServiceMock).not.toHaveBeenCalled();
    expect(createAppServiceMock).not.toHaveBeenCalled();
    expect(context).toEqual({
      prisma: overrides.prisma,
      actualService: overrides.actualService,
      homeValuesService: overrides.homeValuesService,
      plaidService: overrides.plaidService,
      providerSettingsService: overrides.providerSettingsService,
      simplefinService: overrides.simplefinService,
      stripeService: overrides.stripeService,
      tellerService: overrides.tellerService,
      scheduler: overrides.scheduler,
      authService: overrides.authService,
      appService: overrides.appService
    });
  });

  it("passes an overridden actual service through to the app service factory", () => {
    const actualOverride = {
      name: "override-actual"
    };
    createProviderSettingsServiceMock.mockReturnValue(providerSettingsServiceMock);
    createHomeValuesServiceMock.mockReturnValue(homeValuesServiceMock);
    createAuthServiceMock.mockReturnValue(authServiceMock);
    createAppServiceMock.mockReturnValue(appServiceMock);

    createAppContext({
      actualService: actualOverride as never
    });

    expect(createAppServiceMock).toHaveBeenCalledWith(expect.objectContaining({
      actualService: actualOverride
    }));
  });
});
