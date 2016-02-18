var _ = require('lodash');
var moment = require('moment');

/**
 * @name Loan
 * @summary Models a loan
 * @param {Object}  [props]
 * @param {Number}  [props.interest_rate=0] - Nominal yearly interest rate
 * @param {Number}  [props.principal=0] - Current debt
 * @param {Number}  [props.instalments=0] - Instalments left
 * @param {Number}  [props.instalment=0] - Instalments made up to today
 * @param {String}  [props.pay_every="month"] - Period of payment: month/year/quarter
 * @param {String}  [props.type="annuity"] - Type of payment plan: serial/annuity
 * @param {Number}  [props.invoice_fee=0] - Invoice fee
 * @param {Number}  [props.initial_fee=0] - Initial fee
 * @param {Number}  [props.to_pay] - Amount due current period
 * @param {Number}  [props.amortization=0] - Amortization size current period
 * @param {Number}  [props.interest=0] - Interest size current period
 * @param {Boolean} [props.locked=false] - Locked loan
 * @param {Date}    [props.as_of] - Data current as of
 * @param {Object}  [props.data] - Extra data
 */
var Loan = module.exports = function(props) {
  if(!_.isObject(props) || !props) props = {};

  if(!(this instanceof Loan)) {
    return new Loan(props);
  }

  var defaults = this.getDefaults();
  _.extend(this, defaults, _.pick(props, _.keys(defaults)));
};

/**
 * @summary Return default values for this instance
 * @return {Object}
 */
Loan.prototype.getDefaults = function() {
  return {
    interest_rate: 0,
    principal: 0,
    instalments: 0,
    instalment: 0,
    pay_every: 'month',
    type: 'annuity',
    invoice_fee: 0,
    initial_fee: 0,
    to_pay: 0,
    amortization: 0,
    interest: 0,
    as_of: new Date(),
    locked: false,
    data: {}
  };
};

/**
 * @summary Create a copy of this loan fit for serialization
 * @param {Boolean} [keepAll=false] - Keep all fields even if they are equal to a default value
 * @return {Object}
 */
Loan.prototype.toJSON = function(keepAll) {
  keepAll = _.isBoolean(keepAll) ? keepAll : false;

  var self = this;
  var defaults = this.getDefaults();
  var fields = [
    'interest_rate', 'principal', 'instalments', 'instalment', 'pay_every',
    'type', 'invoice_fee', 'initial_fee', 'to_pay', 'amortization',
    'interest', 'as_of', 'data', 'locked'
  ];

  return _.reduce(fields, function(json, key) {
    if(key === 'data') {
      if(!self[key]) return json;
      json[key] = _.omit(self[key], 'payment_plan'); // omit the payment_plan
    } else if(keepAll || self[key] !== defaults[key]) {
      json[key] = self[key];
    }
    return json;
  }, {});
};

/**
 * @summary Calculate the total cost of the loan
 * @return {Number}
 */
Loan.prototype.getTotalCost = function() {
  if(this.instalments < 1) return 0;
  return _.reduce(this.getPaymentPlan(), function(total, curr) {
    return total + curr.invoice_fee + curr.initial_fee + curr.interest;
  }, 0);
};

/**
 * @summary Calculate some meta fields and put them in the data object
 */
Loan.prototype.calculateMeta = function() {
  if(!this.data) this.data = {};
  var locked = this.locked;
  var plan = this.getPaymentPlan();
  var fplan = _.first(plan) || {};

  var ndata = {
    interest_rate_effective: this.getEffectiveInterestRate(),
    should_amortize: this.shouldAmortize(),
    monthly_cost: (fplan.to_pay || 0) + (fplan.invoice_fee || 0),
    total_cost: this.getTotalCost() || 0
  };

  // omit existing keys in data when loan is locked
  ndata = locked ? _.omit(ndata, _.keys(this.data)) : ndata;
  this.data = _.extend(this.data, ndata);
  return this.data;
};

/**
 * @summary Return a payment plan for a loan
 */
Loan.prototype.getPaymentPlan = function() {
  var self = this;
  if(this.instalments < 1) return [];

  var range = _.range(this.instalments);
  var interestRate = this.getInterestRatePerInstalment();
  var asOf = moment(this.as_of);
  var type = this.type;

  // for zero interest rate, let all loans fall back to be serial
  if(this.interest_rate === 0) {
    type = 'serial';
  }

  switch(type) {

    /**
     * @summary A serial loan has the same amortization every payment event
     */
    case 'serial':
       // same for every iteration
      var amortization = this.principal / this.instalments;

      return _.reduce(range, function(plan, instalment) {
        var isFirst = plan.length <= 0;
        var payment = isFirst ? self.toJSON(true) : _.clone(_.last(plan));

        payment.amortization = amortization;
        payment.principal = isFirst ? payment.principal : payment.principal - payment.amortization;
        payment.interest = payment.principal * interestRate;
        payment.to_pay = payment.amortization + payment.interest;
        payment.initial_fee = isFirst ? payment.initial_fee : 0;
        payment.instalments = isFirst ? payment.instalments : payment.instalments - 1;
        payment.instalment = isFirst ? payment.instalment : payment.instalment + 1;
        payment.as_of = self.getDateOfInstalment(instalment);

        plan.push(payment);
        return plan;
      }, []);

    /**
     * @summary An annuity loan has the same total payment every payment event
     */
    case 'annuity':
      // same for every iteration
      var toPay = (interestRate * this.principal) / (1 - Math.pow(1 + interestRate, -self.instalments));

      return _.reduce(range, function(plan, instalment) {
        var isFirst = plan.length <= 0;
        var payment = isFirst ? self.toJSON(true) : _.clone(_.last(plan));

        payment.principal = isFirst ? payment.principal : payment.principal - payment.amortization;
        payment.interest = payment.principal * interestRate;
        payment.amortization = toPay - payment.interest;
        payment.initial_fee = isFirst ? payment.initial_fee : 0;
        payment.instalments = isFirst ? payment.instalments : payment.instalments - 1;
        payment.instalment = isFirst ? payment.instalment : payment.instalment + 1;
        payment.to_pay = toPay;
        payment.as_of = self.getDateOfInstalment(instalment);

        plan.push(payment);
        return plan;
      }, []);

  }

};

/**
 * @summary Return a copy of this loan passed through Loan.rounded
 * @param {Number} [precision]
 * @return {Object}
 */
Loan.prototype.round = function(precision) {
  return Loan.round(this.toJSON(), precision);
};

/**
 * @summary Get the interest rate (per instalment - considers pay_every)
 * @return {Number}
 */
Loan.prototype.getInterestRatePerInstalment = function() {
  switch(this.pay_every) {
    case 'month': return this.interest_rate / 12;
    case 'quarter': return this.interest_rate / 4;
    case 'year': return this.interest_rate;
  }
  return 0;
};

/**
 * @summary Get the date (as_of) the instalment of a certain number in a series
 * @param {Number} instalment - Instalment to return
 * @return {Date}
 */
Loan.prototype.getDateOfInstalment = function(instalment) {
  if(!_.isNumber(instalment) || !isFinite(instalment)) {
    return _.isDate(this.as_of) ? this.as_of : null;
  }
  return moment(this.as_of || undefined).add(instalment, this.pay_every).startOf(this.pay_every).toDate();
};

/**
 * @summary Get the effective yearly interest rate
 * @param {String} [method="secant"] - Method to use
 * @return {Number}
 */
Loan.prototype.getEffectiveInterestRate = function(method) {
  method = method || 'secant';
  if(this.instalments < 1) return 0;

  var invoiceFee = this.invoice_fee || 0;
  var initialFee = this.initial_fee || 0;

  var interest = this.getInterestRatePerInstalment();
  var instalments = this.instalments;
  var principal = this.principal || 0;

  switch(this.type) {

    case 'annuity':

      switch(method) {

        /**
         * @summary Secant method
         */
        case 'secant':
          var payment = -PMT(interest, instalments, -principal-initialFee, 0, 0);
          var toPay = payment + invoiceFee;
          var rate = RATE(instalments, toPay, -principal, 0, 0, interest * 12) * 12;
          var effect = EFFECT(rate, 12);
          return effect;

        /**
         * @summary Newton-Rhapson method
         */
        case 'newton':
          var P = this.principal;
          var m = (this.getTotalCost() + this.principal) / this.instalments;
          var N = this.instalments;

          var approx = 0.1 / 12;
          var papprox = 0;
          for(var k = 0; k < 20; k++) {
            papprox = approx;
            approx = papprox - f(papprox) / df(papprox);
            if(Math.abs(approx - papprox) < Math.pow(10, -10)) break;
          }

          return approx * 12;

      }
  }

  return 0;

  function f(x) {
    return P * x * Math.pow(1 + x, N) / (Math.pow(1 + x, N) - 1) - m;
  }

  function df(x) {
    return P * (Math.pow(1 + x, N) / (-1 + Math.pow(1 + x, N)) - N * x * Math.pow(1 + x, -1 + 2 * N) / Math.pow(-1 + Math.pow(1 + x, N), 2) + N * x * Math.pow(1 + x, -1 + N) / (-1 + Math.pow(1 + x, N)));
  }

  function EFFECT(rate, npery) {
    var effect_value = (Math.pow(1 + (rate/npery), npery)) - 1;
    return roundTo(effect_value, 4);
  }

  function RATE(nper, pmt, pv, fv, type, guess) {
    var f = 0, y = 0, i = 0, x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    rate = guess;
    if (Math.abs(rate) < 0.0000001) {
      y = pv * (1 + nper * rate) + pmt * (1 + rate * type) * nper + fv;
    } else {
      f = Math.exp(nper * Math.log(1 + rate));
      y = pv * f + pmt * (1 / rate + type) * (f - 1) + fv;
    }
    y0 = pv + pmt * nper + fv;
    y1 = pv * f + pmt * (1 / rate + type) * (f - 1) + fv;

    // find root by secant method
    x1 = rate;
    while ((Math.abs(y0 - y1) > 0.0000001) && (i < 20 )) {
      rate = (y1 * x0 - y0 * x1) / (y1 - y0);
      x0 = x1;
      x1 = rate;

      if (Math.abs(rate) < 0.0000001) {
        y = pv * (1 + nper * rate) + pmt * (1 + rate * type) * nper + fv;
      } else {
        f = Math.exp(nper * Math.log(1 + rate));
        y = pv * f + pmt * (1 / rate + type) * (f - 1) + fv;
      }

      y0 = y1;
      y1 = y;
      ++i;
    }
    return rate;
  }

  function PMT(ir, np, pv, fv){
    return ir * -(fv-Math.pow((1+ir),np)*pv) / (-1+Math.pow((1+ir),np));
  }

};

/**
 * @summary Determine if this loan should be automatically amortized
 * @param {Date} [compare] - Date to compare with
 * @return {Boolean}
 */
Loan.prototype.shouldAmortize = function(compare) {
  compare = _.isDate(compare) ? moment(compare) : moment();

  if(!_.isDate(this.as_of)) {
    return false;
  }

  // can never amortize a loan without instalments or principal left
  if(this.instalments <= 0 || this.principal <= 0) {
    return false;
  }

  var payEvery = this.pay_every;
  var asOf = moment(this.as_of);

  return asOf.startOf(payEvery).toDate() < compare.startOf(payEvery).toDate();
};

/**
 * @summary Return an amortized copy of the loan
 * @param {Date} [toDate] - The loan has been will be amortized up until this date
 * @return {Object} - Copy of the loan object with amortization added
 */
Loan.prototype.amortize = function(toDate) {
  toDate = _.isDate(toDate) ? moment(toDate) : moment();

  if(!_.isDate(this.as_of)) {
    return this.toJSON();
  }

  var plan = this.getPaymentPlan();
  var diff = Math.ceil(toDate.diff(this.as_of, this.pay_every));

  // out of bounds - loan has been fully amortized
  if(diff > this.instalments) {
    var last = _.last(plan);
    return new Loan(_.extend(last, {
      principal: 0,
      instalment: last.instalment + 1,
      instalments: 0
    }));
  }

  var amortized = plan[diff] || {};
  var loan = new Loan(amortized);
  loan.calculateMeta();
  return new Loan(amortized);
};

/**
 * @summary Returns the passed loan with rounded properties
 * @param {Object|Loan} loan
 * @param {Number} [precision] - Round to this precision
 * @return {Object}
 */
Loan.round = function(loan, precision) {
  if(!loan || (!_.isObject(loan) && !(loan instanceof Loan))) return null;
  if(!_.isNumber(precision)) return loan;
  _.each(['principal', 'invoice_fee', 'initial_fee', 'amortization', 'interest', 'to_pay'], _.partial(maybeRound, loan, roundTo));
  if(loan.data) {
    _.each(['monthly_cost', 'total_cost'], _.partial(maybeRound, loan.data, roundTo));
    _.each(['interest_rate_effective'], _.partial(maybeRound, loan.data, roundInterestTo));
  }
  return loan;

  function maybeRound(container, fn, prop) {
    var num = container[prop];
    if(!_.isNumber(num) || !isFinite(num)) return;
    container[prop] = fn(num, precision);
  }
};

function roundInterestTo(num, precision) {
  if(!_.isNumber(num) || !isFinite(num)) return NaN;
  num = roundTo(num * 100, precision + 1);
  return num / 100;
}

function roundTo(num, precision) {
  if(!_.isNumber(num) || !isFinite(num)) return NaN;
  if(!(precision >= 0)) return num;
  var fac = Math.pow(10, precision);
  num = Math.round(num * fac);
  return num / fac;
}